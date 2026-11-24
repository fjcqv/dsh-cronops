/**
 * Qinglong (青龙面板) adapter.
 *
 * Wire contract: every call goes to `<baseUrl>/open/<path>` with
 * `Authorization: Bearer …`. The token is an application access token from
 * `GET /open/auth/token?client_id=&client_secret=` (`data.token` plus
 * `data.expiration`, a Unix **second** timestamp). Most business failures come
 * back as HTTP 200 with a `{ code, message }` envelope where `code` decides
 * success, so `parseResponse` — not the status alone — is the source of truth.
 */

import { OPEN_PREFIX } from '../protocol.js'
import { PanelDriver, PanelError, classifyProbeError, encodeQuery } from './driver.js'
import { previewCron } from '../cron-preview.js'

/** Refresh ceiling when the panel declares no expiration. */
const FALLBACK_TOKEN_TTL_MS = 3_600_000

/** Extract `message` from a JSON envelope, when it is a string. */
function messageOf(body) {
  if (typeof body !== 'object' || body === null) return undefined
  const message = body.message
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined
}

/** Whether a JSON envelope reports a credential problem. */
function isAuthFailure(status, body) {
  if (status === 401) return true
  const code = typeof body === 'object' && body !== null ? body.code : undefined
  if (code === 401) return true
  const message = messageOf(body)
  return message !== undefined && /token|登录|未授权|authorization/i.test(message)
}

/**
 * The Qinglong driver: shared transport from {@link PanelDriver}, Qinglong's
 * envelope parsing and its OpenAPI resource calls.
 */
export class QinglongDriver extends PanelDriver {
  /**
   * @param store - the panel store.
   * @param options - request timeout.
   */
  constructor(store, options = {}) {
    super(store, { ...options, kind: 'qinglong' })
  }

  prefixFor() {
    return OPEN_PREFIX
  }

  authRequest(entry) {
    return {
      url: `${entry.baseUrl}${OPEN_PREFIX}/auth/token` + encodeQuery({
        client_id: entry.auth.appKey,
        client_secret: entry.auth.appSecret,
      }),
      method: 'GET',
      label: '获取应用 token',
    }
  }

  readToken(body, response) {
    const data = body?.data
    if (typeof data !== 'object' || data === null || typeof data.token !== 'string' || data.token === '') {
      throw this.fail('青龙返回的 token 响应缺少 data.token', { status: response.status, code: body?.code })
    }
    const expiration = typeof data.expiration === 'number' ? data.expiration : undefined
    return {
      token: data.token,
      // No expiration declared: refresh after a conservative hour.
      expiresAt: expiration === undefined ? Date.now() + FALLBACK_TOKEN_TTL_MS : expiration * 1000,
    }
  }

  /**
   * Parse one HTTP response into a Qinglong JSON envelope.
   * @param response - status/text from the transport.
   * @param what - operation label for the error message.
   * @returns the parsed envelope.
   * @throws PanelError on a non-JSON body, an HTTP error, or `code !== 200`.
   */
  parseResponse(response, what) {
    let body
    try {
      body = JSON.parse(response.text)
    } catch {
      const snippet = response.text.replace(/\s+/g, ' ').slice(0, 200)
      throw this.fail(
        `${what} 返回了非 JSON 响应（HTTP ${response.status}）${snippet === '' ? '' : ': ' + snippet}`,
        { status: response.status, malformed: true, needsAuth: response.status === 401 },
      )
    }
    const code = typeof body === 'object' && body !== null && typeof body.code === 'number' ? body.code : undefined
    if (code !== undefined && code !== 200) {
      throw this.fail(messageOf(body) ?? `${what} 失败（code ${code}）`, {
        status: response.status,
        code,
        needsAuth: isAuthFailure(response.status, body),
      })
    }
    if (response.status >= 400) {
      throw this.fail(messageOf(body) ?? `${what} 失败（HTTP ${response.status}）`, {
        status: response.status,
        code,
        needsAuth: response.status === 401,
      })
    }
    return body
  }

  /** `/open/system` is public: reachability must not depend on the credential. */
  async connect(alias) {
    const envelope = await this.anonymous(alias, '/system')
    return typeof envelope?.data?.version === 'string' ? envelope.data.version : undefined
  }

  /** `/envs` is the cheapest scope this plugin's UI needs. */
  cheapestRead() {
    return { path: '/envs', query: { searchValue: '__dsh_probe__' } }
  }

  forbiddenMessage() {
    return 'token 有效，但该应用缺少 envs 权限'
  }

  probeTargets() {
    return {
      envs: { path: '/envs', query: { searchValue: '__dsh_probe__' } },
      crons: { path: '/crons', query: { page: 1, size: 1 } },
      subscriptions: { path: '/subscriptions' },
      configs: { path: '/configs/files' },
      scripts: { path: '/scripts' },
      logs: { path: '/logs' },
      dashboard: { path: '/dashboard/overview' },
    }
  }

  /**
   * `dependencies` walks every runtime (measured 10-16 s on a real panel), so
   * it runs after the parallel batch: try the filtered read first, then the
   * unfiltered list with a generous ceiling for panels that ignore `type`.
   */
  async probeExtra(alias, entry) {
    const base = entry.timeoutMs ?? this.timeoutMs
    const scopes = {}
    try {
      await this.data(alias, { path: '/dependencies', query: { type: 'python3' }, timeoutMs: Math.min(base, 8_000) })
      scopes.dependencies = 'ok'
    } catch (error) {
      const state = classifyProbeError(error)
      if (state === 'forbidden' || state === 'auth') {
        scopes.dependencies = state
      } else {
        try {
          await this.data(alias, { path: '/dependencies', timeoutMs: Math.max(base, 25_000) })
          scopes.dependencies = 'ok'
        } catch (retryError) {
          scopes.dependencies = classifyProbeError(retryError)
        }
      }
    }
    try {
      await this.anonymous(alias, '/system')
      scopes.system = 'public'
    } catch {
      scopes.system = 'error'
    }
    return scopes
  }

  /** A retried stop must address the same accepted instances (panel docs). */
  extraHeaders(options) {
    return options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }
  }

  // ----------------------------------------------------------------- envs

  /** List environment variables. */
  async envsList(alias, searchValue) {
    const data = await this.data(alias, { path: '/envs', query: { searchValue } })
    return Array.isArray(data) ? data : []
  }

  /** Create environment variables (the panel takes an array). */
  async envsCreate(alias, envs) {
    return await this.data(alias, { method: 'POST', path: '/envs', body: envs })
  }

  /**
   * Update one environment variable. The panel requires id/name/value, so the
   * stored row is read first and the patch merged onto it.
   * @param alias - panel alias.
   * @param id - variable id.
   * @param patch - fields to change.
   * @returns the updated row from the panel.
   */
  async envsUpdate(alias, id, patch) {
    const current = await this.data(alias, { path: `/envs/${encodeURIComponent(String(id))}` })
    const base = typeof current === 'object' && current !== null ? current : {}
    const name = typeof patch.name === 'string' && patch.name !== '' ? patch.name : base.name
    const value = typeof patch.value === 'string' ? patch.value : base.value
    if (typeof name !== 'string' || name === '') throw this.fail('环境变量名称不能为空')
    if (typeof value !== 'string') throw this.fail('环境变量值不能为空')
    const body = {
      id: Number(id),
      name,
      value,
      remarks: typeof patch.remarks === 'string' ? patch.remarks : (base.remarks ?? ''),
    }
    const labels = patch.labels ?? base.labels
    if (Array.isArray(labels)) body.labels = labels
    return await this.data(alias, { method: 'PUT', path: '/envs', body })
  }

  /** Delete environment variables by id. */
  async envsRemove(alias, ids) {
    return await this.data(alias, { method: 'DELETE', path: '/envs', body: ids })
  }

  /** Enable or disable environment variables by id. */
  async envsToggle(alias, action, ids) {
    if (action !== 'enable' && action !== 'disable') throw this.fail(`未知操作 '${action}'`)
    return await this.data(alias, { method: 'PUT', path: `/envs/${action}`, body: ids })
  }

  // ---------------------------------------------------------------- crons

  /** List scheduled tasks; returns rows plus pagination metadata when present. */
  async cronsList(alias, query) {
    const data = await this.data(alias, { path: '/crons', query })
    if (Array.isArray(data)) return { rows: data }
    if (typeof data === 'object' && data !== null && Array.isArray(data.data)) {
      return {
        rows: data.data,
        total: typeof data.total === 'number' ? data.total : data.data.length,
      }
    }
    return { rows: [] }
  }

  /** Read one scheduled task. */
  async cronsGet(alias, id) {
    return await this.data(alias, { path: `/crons/${encodeURIComponent(String(id))}` })
  }

  /** Create a scheduled task. */
  async cronsCreate(alias, cron) {
    try {
      return await this.data(alias, { method: 'POST', path: '/crons', body: cron })
    } catch (error) {
      throw this.scheduleHint(error)
    }
  }

  /**
   * The panel answers an impossible date (30 February) with a bare
   * "Validation failed" and no field name. Point at the only field that
   * behaves that way — done here so the console and the agent tools both see it.
   * @param error - the thrown value.
   * @returns the same error after its message is amended.
   */
  scheduleHint(error) {
    if (
      error instanceof PanelError &&
      /validation failed/i.test(error.message) &&
      !/schedule|定时/i.test(error.message)
    ) {
      error.message = `${error.message}（多半是 schedule：需要 5 段标准 cron「分 时 日 月 周」，2 月 30 日这类不存在的日期会被拒）`
    }
    return error
  }

  /**
   * Update a scheduled task. The panel rejects partial bodies (`command` and
   * `schedule` are mandatory), so the current task is read and the patch
   * merged onto it.
   * @param alias - panel alias.
   * @param id - task id.
   * @param patch - fields to change.
   * @returns the panel's response data.
   */
  async cronsUpdate(alias, id, patch) {
    const current = await this.cronsGet(alias, id)
    if (typeof current !== 'object' || current === null) throw this.fail(`任务 ${id} 不存在`)
    const next = { ...current, ...patch, id: Number(id) }
    if (typeof next.command !== 'string' || next.command.trim() === '') throw this.fail('任务命令不能为空')
    if (typeof next.schedule !== 'string' || next.schedule.trim() === '') throw this.fail('定时规则不能为空')
    const body = {
      id: Number(id),
      name: next.name ?? '',
      command: next.command,
      schedule: next.schedule,
      labels: Array.isArray(next.labels) ? next.labels : [],
      ...(next.task_before !== undefined ? { task_before: next.task_before } : {}),
      ...(next.task_after !== undefined ? { task_after: next.task_after } : {}),
      ...(next.work_dir !== undefined && next.work_dir !== null ? { work_dir: next.work_dir } : {}),
      ...(next.log_name !== undefined && next.log_name !== null ? { log_name: next.log_name } : {}),
      ...(next.allow_multiple_instances !== undefined ? { allow_multiple_instances: Number(next.allow_multiple_instances) } : {}),
    }
    try {
      return await this.data(alias, { method: 'PUT', path: '/crons', body })
    } catch (error) {
      throw this.scheduleHint(error)
    }
  }

  /** Delete scheduled tasks by id. */
  async cronsRemove(alias, ids) {
    await this.data(alias, { method: 'DELETE', path: '/crons', body: ids })
    // 青龙 answers DELETE with no data at all; report the accepted ids instead
    // of `null`, so a caller can tell "accepted" from "nothing happened".
    return { ok: true, deleted: ids }
  }

  /**
   * Run, stop, enable or disable scheduled tasks.
   * @param alias - panel alias.
   * @param action - run | stop | enable | disable.
   * @param ids - task ids.
   */
  async cronsAction(alias, action, ids) {
    if (!['run', 'stop', 'enable', 'disable'].includes(action)) throw this.fail(`未知操作 '${action}'`)
    const options = { method: 'PUT', path: `/crons/${action}`, body: ids }
    if (action === 'stop') options.idempotencyKey = globalThis.crypto.randomUUID()
    await this.data(alias, options)
    // Same empty body as DELETE: echo what the panel accepted.
    return { ok: true, action, ids }
  }

  /**
   * Read a task's execution log.
   * @param alias - panel alias.
   * @param id - task id.
   * @param query - offset/limit/tail plus optional trigger/instance ids.
   * @returns the envelope plus the log metadata the panel adds next to `data`.
   */
  async cronsLog(alias, id, query) {
    return await this.call(alias, { path: `/crons/${encodeURIComponent(String(id))}/log`, query })
  }

  /** List the stored log files of one task. */
  async cronsLogFiles(alias, id) {
    return await this.data(alias, { path: `/crons/${encodeURIComponent(String(id))}/logs` })
  }

  /** Preview the next triggers of a cron expression. */
  async cronsPreview(alias, schedule) {
    // 2.24 has no preview route: the request falls through to `/crons/:id` and
    // comes back as a bare "Validation failed", which reads like a broken
    // expression. Compute it here instead of asking the panel.
    this.entry(alias)
    return previewCron(schedule)
  }
}
