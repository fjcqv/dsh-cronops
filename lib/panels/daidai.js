/**
 * Daidai (呆呆面板) adapter.
 *
 * Wire contract, all of it different from Qinglong's:
 *
 * - prefix `/api/v1` (legacy installs only answer `/api`; the driver falls back
 *   when `/api/v1/version` is missing),
 * - token: `POST /api/v1/open-api/token` `{app_key, app_secret}` →
 *   `{data:{access_token, token_type, expires_in}}` (one envelope level deeper
 *   than Qinglong), valid 24 hours,
 * - errors are real HTTP statuses with `{"error": "…"}`, not HTTP 200 +
 *   `{code, message}`,
 * - scopes are module names (`tasks`, `envs`, `logs`, …), and an application
 *   token is admitted by the scope middleware, so a granted scope also allows
 *   operator-level writes,
 * - resources are `tasks` (not `crons`), a task has no single-read endpoint, and
 *   the batch endpoints cap at 10 ids.
 *
 * Everything a caller sees is normalized to the shapes the routes, the agent
 * tools and the browser half already understand.
 */

import { PanelDriver, PanelError, compact, joinScriptPath } from './driver.js'
import { previewCron } from '../cron-preview.js'

/** Current API prefix. */
const PREFIX = '/api/v1'

/** Legacy prefix registered by the same handlers. */
const LEGACY_PREFIX = '/api'

/** Daidai's batch endpoints accept at most this many ids per request. */
const BATCH_LIMIT = 10

/** Read the `error` message of a Daidai failure body. */
function errorOf(body) {
  if (typeof body === 'string') return body
  if (typeof body === 'object' && body !== null && typeof body.error === 'string') return body.error
  return undefined
}

/** Split the comma separated group/label strings Daidai stores. */
function splitGroups(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(/[,，;；\n]/).map(item => item.trim()).filter(item => item !== '')
}

/** Normalize one Daidai environment row. */
function mapEnv(row) {
  const enabled = row.enabled !== false
  return compact({
    id: row.id,
    name: row.name ?? '',
    value: row.value ?? '',
    remarks: row.remarks ?? '',
    // The browser half reads the Qinglong vocabulary: status 1 = disabled.
    status: enabled ? 0 : 1,
    isDisabled: enabled ? 0 : 1,
    labels: splitGroups(row.group),
    group: row.group ?? '',
    important: row.important === true,
    position: row.position,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

/**
 * Normalize one Daidai task into the Qinglong-ish shape the UI renders.
 * Daidai status: 0 disabled, 0.5 queued, 1 enabled, 2 running.
 */
function mapTask(row) {
  const rawStatus = Number(row.status)
  const enabled = typeof row.enabled === 'boolean' ? row.enabled : rawStatus !== 0
  const status = rawStatus === 2 ? 0 : rawStatus === 0.5 ? 3 : enabled ? 1 : 2
  return compact({
    id: row.id,
    name: row.name ?? '',
    command: row.command ?? '',
    schedule: row.cron_expression ?? '',
    labels: Array.isArray(row.labels) ? row.labels : splitGroups(row.labels),
    isDisabled: enabled ? 0 : 1,
    status,
    last_execution_time: row.last_run_at ?? null,
    last_run_status: row.last_run_status ?? null,
    next_run_at: row.next_run_at ?? null,
    task_before: row.task_before ?? '',
    task_after: row.task_after ?? '',
    work_dir: '',
    allow_multiple_instances: row.allow_multiple_instances === true ? 1 : 0,
    timeout: row.timeout ?? 0,
    raw: row,
  })
}

/** Project our normalized task payload onto Daidai's create body. */
function toDaidaiTask(cron) {
  const body = {
    name: typeof cron.name === 'string' && cron.name !== '' ? cron.name : String(cron.command ?? '').slice(0, 60),
    command: String(cron.command ?? ''),
    cron_expression: String(cron.schedule ?? ''),
    labels: Array.isArray(cron.labels) ? cron.labels : [],
  }
  if (typeof cron.task_before === 'string' && cron.task_before !== '') body.task_before = cron.task_before
  if (typeof cron.task_after === 'string' && cron.task_after !== '') body.task_after = cron.task_after
  if (cron.allow_multiple_instances !== undefined) body.allow_multiple_instances = Number(cron.allow_multiple_instances) === 1
  return body
}

/** Project one PATCH onto Daidai's partial-update body. */
function toDaidaiTaskPatch(patch) {
  const body = {}
  if (typeof patch.name === 'string') body.name = patch.name
  if (typeof patch.command === 'string') body.command = patch.command
  if (typeof patch.schedule === 'string') body.cron_expression = patch.schedule
  if (Array.isArray(patch.labels)) body.labels = patch.labels
  if (typeof patch.task_before === 'string') body.task_before = patch.task_before
  if (typeof patch.task_after === 'string') body.task_after = patch.task_after
  if (patch.allow_multiple_instances !== undefined) body.allow_multiple_instances = Number(patch.allow_multiple_instances) === 1
  return body
}

/** Project one environment payload onto Daidai's body. */
function toDaidaiEnv(env) {
  const body = { name: env.name, value: env.value }
  if (typeof env.remarks === 'string') body.remarks = env.remarks
  const group = typeof env.group === 'string' ? env.group : Array.isArray(env.labels) ? env.labels.join(',') : undefined
  if (group !== undefined) body.group = group
  if (env.important !== undefined) body.important = env.important === true
  return body
}

/**
 * The Daidai driver: shared transport from {@link PanelDriver}, Daidai's
 * status-based envelope and its `/api/v1` resource calls.
 */
export class DaidaiDriver extends PanelDriver {
  /**
   * @param store - the panel store.
   * @param options - request timeout.
   */
  constructor(store, options = {}) {
    super(store, { ...options, kind: 'daidai' })
  }

  /** `/api/v1` by default; the per-alias `legacy` marker after a fallback. */
  prefixFor(entry) {
    return this.prefixes.get(entry.alias) === 'legacy' ? LEGACY_PREFIX : PREFIX
  }

  authRequest(entry) {
    return {
      url: entry.baseUrl + this.prefixFor(entry) + '/open-api/token',
      method: 'POST',
      body: { app_key: entry.auth.appKey, app_secret: entry.auth.appSecret },
      label: '获取应用令牌',
    }
  }

  readToken(body, response) {
    // The token payload sometimes sits one level shallower on legacy builds.
    const data = typeof body?.data === 'object' && body.data !== null ? body.data : body
    if (typeof data?.access_token !== 'string' || data.access_token === '') {
      throw this.fail('呆呆面板返回的令牌响应缺少 access_token', { status: response.status })
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 86_400
    return { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 }
  }

  /**
   * Parse one HTTP response into a JSON body.
   * @param response - transport result.
   * @param what - operation label for the error message.
   * @returns the parsed body.
   * @throws PanelError for a non-2xx status or a non-JSON body.
   */
  parseResponse(response, what) {
    let body
    try {
      body = response.text === '' ? {} : JSON.parse(response.text)
    } catch {
      const snippet = response.text.replace(/\s+/g, ' ').slice(0, 200)
      throw this.fail(
        `${what} 返回了非 JSON 响应（HTTP ${response.status}）${snippet === '' ? '' : ': ' + snippet}`,
        { status: response.status, malformed: true, needsAuth: response.status === 401, forbidden: response.status === 403 },
      )
    }
    if (response.status >= 200 && response.status < 300) return body
    throw this.fail(errorOf(body) ?? `${what} 失败（HTTP ${response.status}）`, {
      status: response.status,
      code: response.status,
      needsAuth: response.status === 401,
      forbidden: response.status === 403,
    })
  }

  /** `/version` is public; a legacy panel only answers `/api/version`. */
  async connect(alias, entry) {
    try {
      const body = await this.anonymous(alias, '/version')
      return typeof body?.version === 'string' ? body.version : undefined
    } catch (error) {
      if (!(error?.status === 404)) throw error
      this.prefixes.set(entry.alias, 'legacy')
      const body = await this.anonymous(alias, '/version')
      return typeof body?.version === 'string' ? body.version : undefined
    }
  }

  /** 呆呆 keys code by one joined path and answers `{content, path, binary}`. */
  async scriptsRead(alias, dir, file) {
    return await this.call(alias, { method: 'GET', path: '/scripts/content', query: { path: joinScriptPath(dir, file) } })
  }

  /** One verb: PUT rewrites or creates, no 404 dance. */
  async scriptsWrite(alias, dir, file, content) {
    return await this.call(alias, { method: 'PUT', path: '/scripts/content', body: { path: joinScriptPath(dir, file), content } })
  }

  async scriptsRun(alias, dir, file) {
    return await this.call(alias, { method: 'POST', path: '/scripts/run', body: { path: joinScriptPath(dir, file) } })
  }

  cheapestRead() {
    return { path: '/tasks', query: { page: 1, page_size: 1 } }
  }

  forbiddenMessage(error) {
    return `token 有效，但该应用缺少 tasks 权限：${error.message}`
  }

  /**
   * One cheap read per module. `notifications` is deliberately absent: its
   * routes need a panel user token, so an application credential always gets
   * 403 and the answer would say nothing about the app's scopes.
   */
  probeTargets() {
    return {
      tasks: { path: '/tasks', query: { page: 1, page_size: 1 } },
      envs: { path: '/envs', query: { page: 1, page_size: 1 } },
      logs: { path: '/logs', query: { page: 1, page_size: 1 } },
      scripts: { path: '/scripts' },
      subscriptions: { path: '/subscriptions' },
      system: { path: '/system/info' },
      backup: { path: '/system/backups' },
    }
  }

  // ----------------------------------------------------------------- envs

  /** List environment variables (Daidai pages, we ask for everything). */
  async envsList(alias, searchValue) {
    const body = await this.call(alias, {
      path: '/envs',
      query: { keyword: searchValue, page: 1, page_size: 100, all: 1 },
    })
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    return rows.map(mapEnv)
  }

  /**
   * Daidai wraps every write in `{data, message}` while 青龙 answers flat. The
   * tool layer renders what it gets, so the envelope is unwrapped here: one
   * shape for both products.
   */
  unwrap(body) {
    return body?.data === undefined ? body : body.data
  }

  /** Create environment variables (Daidai accepts an array in one request). */
  async envsCreate(alias, envs) {
    return this.unwrap(await this.call(alias, { method: 'POST', path: '/envs', body: envs.map(toDaidaiEnv) }))
  }

  /** Update one environment variable (Daidai accepts a partial body). */
  async envsUpdate(alias, id, patch) {
    const body = {}
    if (typeof patch.name === 'string' && patch.name !== '') body.name = patch.name
    if (typeof patch.value === 'string') body.value = patch.value
    if (typeof patch.remarks === 'string') body.remarks = patch.remarks
    if (typeof patch.group === 'string') body.group = patch.group
    if (Array.isArray(patch.labels)) body.group = patch.labels.join(',')
    if (patch.important !== undefined) body.important = patch.important === true
    if (Object.keys(body).length === 0) throw this.fail('没有可更新的环境变量字段')
    return this.unwrap(await this.call(alias, { method: 'PUT', path: `/envs/${encodeURIComponent(String(id))}`, body }))
  }

  /** Delete environment variables by id. */
  async envsRemove(alias, ids) {
    return this.unwrap(await this.call(alias, { method: 'DELETE', path: '/envs/batch', body: { ids } }))
  }

  /** Enable or disable environment variables by id. */
  async envsToggle(alias, action, ids) {
    if (action !== 'enable' && action !== 'disable') throw this.fail(`未知操作 '${action}'`)
    return this.unwrap(await this.call(alias, { method: 'PUT', path: `/envs/batch/${action}`, body: { ids } }))
  }

  // ---------------------------------------------------------------- tasks

  /** List scheduled tasks. */
  async cronsList(alias, query) {
    const body = await this.call(alias, {
      path: '/tasks',
      query: {
        keyword: query.searchValue,
        page: query.page ?? 1,
        page_size: query.size ?? 20,
      },
    })
    const rows = Array.isArray(body?.data) ? body.data.map(mapTask) : []
    return { rows, total: typeof body?.total === 'number' ? body.total : rows.length }
  }

  /** Read one task; Daidai has no GET /tasks/:id, so the full list is scanned. */
  async cronsGet(alias, id) {
    const body = await this.call(alias, { path: '/tasks', query: { all: 1 } })
    const rows = Array.isArray(body?.data) ? body.data : []
    const found = rows.find(row => Number(row.id) === Number(id))
    if (found === undefined) throw this.fail(`任务 ${id} 不存在`, { code: 404, status: 404 })
    return mapTask(found)
  }

  /** Create a scheduled task. */
  async cronsCreate(alias, cron) {
    return this.unwrap(await this.call(alias, { method: 'POST', path: '/tasks', body: toDaidaiTask(cron) }))
  }

  /** Update a scheduled task with a partial body. */
  async cronsUpdate(alias, id, patch) {
    const body = toDaidaiTaskPatch(patch)
    if (Object.keys(body).length === 0) throw this.fail('没有可更新的任务字段')
    return this.unwrap(await this.call(alias, { method: 'PUT', path: `/tasks/${encodeURIComponent(String(id))}`, body }))
  }

  /** Delete scheduled tasks by id (batch endpoint, `task_ids`). */
  async cronsRemove(alias, ids) {
    return this.unwrap(await this.call(alias, { method: 'DELETE', path: '/tasks/batch/delete', body: { task_ids: ids } }))
  }

  /**
   * Run / stop / enable / disable tasks. The batch run endpoint caps at
   * {@link BATCH_LIMIT} ids, so larger selections are chunked; the other
   * actions are per task.
   */
  async cronsAction(alias, action, ids) {
    if (!['run', 'stop', 'enable', 'disable'].includes(action)) throw this.fail(`未知操作 '${action}'`)
    const results = []
    if (action === 'run' && ids.length > 1) {
      for (let index = 0; index < ids.length; index += BATCH_LIMIT) {
        const chunk = ids.slice(index, index + BATCH_LIMIT)
        results.push(this.unwrap(await this.call(alias, { method: 'POST', path: '/tasks/batch/run', body: { task_ids: chunk } })))
      }
      return results
    }
    for (const id of ids) {
      results.push(this.unwrap(await this.call(alias, { method: 'PUT', path: `/tasks/${encodeURIComponent(String(id))}/${action}` })))
    }
    return results
  }

  /** Read the latest execution log of one task. */
  async cronsLog(alias, id, query) {
    const body = await this.call(alias, { path: `/tasks/${encodeURIComponent(String(id))}/latest-log` })
    const payload = typeof body?.data === 'object' && body.data !== null ? body.data : body
    const content = typeof payload?.content === 'string' ? payload.content : ''
    // `offset` used to be accepted and silently dropped, so a caller that
    // paginated got the same bytes back forever. Honour it, and report the
    // offset actually used.
    const offset = Number(query?.offset)
    const start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.floor(offset), content.length) : 0
    const rest = content.slice(start)
    const limit = Number(query?.limit)
    const text = Number.isFinite(limit) && limit > 0 ? rest.slice(-limit) : rest
    return {
      data: text,
      logStatus: payload?.status,
      offset: start,
      total: content.length,
      truncated: text.length !== rest.length,
    }
  }

  /** List the stored log files of one task. */
  async cronsLogFiles(alias, id) {
    const body = await this.call(alias, { path: `/tasks/${encodeURIComponent(String(id))}/log-files` })
    return body?.data ?? body
  }

  /** Validate a cron expression and preview its next triggers. */
  async cronsPreview(alias, schedule) {
    const body = await this.call(alias, { method: 'POST', path: '/tasks/cron/parse', body: { expression: schedule } })
    const payload = typeof body?.data === 'object' && body.data !== null ? body.data : body
    // The panel reports an unusable expression as `is_valid: false` with HTTP
    // 200. Returning that as a success would make 呆呆 the only product whose
    // preview never fails, and the caller would read `times: []` as "no match".
    if (payload?.is_valid === false) {
      throw new PanelError(payload?.error ?? `定时表达式被面板拒绝：${schedule}`)
    }
    const times = Array.isArray(payload?.next_run_times) ? payload.next_run_times : []
    // The panel accepts `0 0 30 2 *` as a well-formed expression and simply
    // returns no future run; answering `times: []` would make 呆呆 the only
    // product that does not name the unreachable date.
    if (times.length === 0) return previewCron(schedule)
    return {
      times,
      description: payload?.description,
      format: payload?.format,
      valid: true,
    }
  }
}
