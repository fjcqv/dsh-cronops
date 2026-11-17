/**
 * Daidai Panel (呆呆面板) driver.
 *
 * Same public surface as the Qinglong engine, different wire contract:
 *
 * - prefix `/api/v1` (legacy installs also answer `/api`; the driver falls back
 *   when `/api/v1/version` is missing),
 * - token: `POST /api/v1/open-api/token` `{app_key, app_secret}` →
 *   `{data:{access_token, token_type, expires_in}}` (the envelope nests one
 *   level deeper than Qinglong's), 24 hours,
 * - errors are real HTTP statuses with `{"error": "…"}` instead of Qinglong's
 *   HTTP 200 + `{code, message}`,
 * - scopes are module names (`tasks`, `envs`, `logs`, …), and an application
 *   token is admitted by the scope middleware, so a granted scope also allows
 *   the operator-level writes.
 *
 * Everything a caller sees is normalized to the shapes the routes, the agent
 * tools and the browser half already understand.
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_TIMEOUT_MS,
  QinglongError,
  compact,
  encodeQuery,
  errorMessage,
  httpRequest,
} from './qinglong.js'

/** Current API prefix. */
const PREFIX = '/api/v1'

/** Legacy prefix registered by the same handlers. */
const LEGACY_PREFIX = '/api'

/** 403 wording that means "the token is fine, the scope is not granted". */
const SCOPE_DENIED = /无权访问|权限不足|暂无权限/

/** Read the `error` message of a Daidai failure body. */
function errorOf(body) {
  if (typeof body === 'string') return body
  if (typeof body === 'object' && body !== null && typeof body.error === 'string') return body.error
  return undefined
}

/**
 * Parse one HTTP response into a JSON body, throwing {@link QinglongError} for
 * a non-2xx status or a non-JSON body.
 * @param response - transport result.
 * @param what - operation label for the error message.
 * @returns the parsed body.
 */
function parseDaidaiResponse(response, what) {
  let body
  try {
    body = response.text === '' ? {} : JSON.parse(response.text)
  } catch {
    const snippet = response.text.replace(/\s+/g, ' ').slice(0, 200)
    throw new QinglongError(
      `${what} 返回了非 JSON 响应（HTTP ${response.status}）${snippet === '' ? '' : ': ' + snippet}`,
      { status: response.status, malformed: true, needsAuth: response.status === 401, forbidden: response.status === 403 },
    )
  }
  if (response.status >= 200 && response.status < 300) return body
  const message = errorOf(body) ?? `${what} 失败（HTTP ${response.status}）`
  throw new QinglongError(message, {
    status: response.status,
    code: response.status,
    needsAuth: response.status === 401,
    forbidden: response.status === 403,
  })
}

/** Fingerprint the credential a cached token belongs to. */
function credentialFingerprint(auth) {
  const material = auth.kind === 'open'
    ? `daidai:${auth.appKey}:${auth.appSecret}`
    : `token:${auth.token}`
  return createHash('sha256').update(material).digest('hex')
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

/** Project our normalized task payload onto Daidai's create/update body. */
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
 * The Daidai engine: one instance per plugin mount, shared by the HTTP routes
 * and the agent tools.
 */
export class DaidaiEngine {
  /**
   * @param store - the panel store.
   * @param options - request timeout.
   */
  constructor(store, options = {}) {
    this.store = store
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    /** alias -> { token, expiresAt, fingerprint } */
    this.tokens = new Map()
    /** alias -> in-flight token acquisition. */
    this.logins = new Map()
    /** alias -> { fingerprint, at, scopes } */
    this.scopeCache = new Map()
  }

  /** Apply a new default request timeout. */
  setRequestTimeout(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) this.timeoutMs = ms
  }

  /** Drop cached token and scope map for one panel. */
  dropAlias(alias) {
    this.tokens.delete(alias)
    this.logins.delete(alias)
    this.scopeCache.delete(alias)
  }

  /** Forget every cached value (plugin unload). */
  dispose() {
    this.tokens.clear()
    this.logins.clear()
    this.scopeCache.clear()
  }

  /**
   * Resolve the panel an operation addresses.
   * @param alias - requested alias, or undefined for the default panel.
   * @returns the stored entry.
   */
  entry(alias) {
    if (typeof alias === 'string' && alias !== '') {
      const found = this.store.find(alias)
      if (found === undefined) throw new QinglongError(`panel '${alias}' 不存在`, { code: 404, status: 404 })
      return found
    }
    const fallback = this.store.defaultAlias()
    const found = fallback === undefined ? undefined : this.store.find(fallback)
    if (found === undefined) throw new QinglongError('尚未配置面板，请先在「主机」页签新增一个。', { code: 404, status: 404 })
    return found
  }

  /** The API prefix this panel answers on (v1 by default, legacy after a fallback). */
  prefix(entry) {
    return entry.apiPrefix === 'legacy' ? LEGACY_PREFIX : PREFIX
  }

  /** Acquire (or reuse) the bearer token for one panel. */
  async token(entry) {
    if (entry.auth.kind === 'token') return entry.auth.token
    const fingerprint = credentialFingerprint(entry.auth)
    const cached = this.tokens.get(entry.alias)
    if (cached !== undefined && cached.fingerprint === fingerprint && cached.expiresAt - 60_000 > Date.now()) {
      return cached.token
    }
    const running = this.logins.get(entry.alias)
    if (running !== undefined && running.fingerprint === fingerprint) return running.promise
    const promise = this.login(entry, fingerprint)
    this.logins.set(entry.alias, { fingerprint, promise })
    try {
      return await promise
    } finally {
      const current = this.logins.get(entry.alias)
      if (current !== undefined && current.promise === promise) this.logins.delete(entry.alias)
    }
  }

  /** Trade app_key/app_secret for a 24 h access token. */
  async login(entry, fingerprint) {
    const url = entry.baseUrl + this.prefix(entry) + '/open-api/token'
    const response = await httpRequest(url, {
      method: 'POST',
      body: { app_key: entry.auth.appKey, app_secret: entry.auth.appSecret },
      timeoutMs: entry.timeoutMs ?? this.timeoutMs,
      insecureTls: entry.insecureTls,
    })
    let body
    try {
      body = parseDaidaiResponse(response, '获取应用令牌')
    } catch (error) {
      // A rejected credential is not a transport failure: report it as such so
      // the probe says "credential rejected" and the user edits the key pair.
      if (error instanceof QinglongError) {
        throw new QinglongError(error.message, {
          status: error.status,
          code: error.code,
          needsAuth: true,
          forbidden: error.forbidden === true,
        })
      }
      throw error
    }
    const data = typeof body?.data === 'object' && body.data !== null ? body.data : body
    if (typeof data?.access_token !== 'string' || data.access_token === '') {
      throw new QinglongError('呆呆面板返回的令牌响应缺少 access_token', { status: response.status })
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 86_400
    this.tokens.set(entry.alias, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      fingerprint,
    })
    return data.access_token
  }

  /** Perform one `/api/v1` call and return the parsed body. */
  async call(alias, options) {
    const entry = this.entry(alias)
    const prefix = this.prefix(entry)
    const method = (options.method ?? 'GET').toUpperCase()
    const path = options.path.startsWith('/') ? options.path : '/' + options.path
    const url = entry.baseUrl + prefix + path + encodeQuery(options.query)
    const timeoutMs = options.timeoutMs ?? entry.timeoutMs ?? this.timeoutMs
    const send = async token => {
      const response = await httpRequest(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: options.body,
        timeoutMs,
        insecureTls: entry.insecureTls,
      })
      return parseDaidaiResponse(response, `${method} ${prefix}${path}`)
    }
    let token = await this.token(entry)
    try {
      return await send(token)
    } catch (error) {
      if (!(error instanceof QinglongError) || entry.auth.kind === 'token' || options.retryOnAuth === false) throw error
      if (error.needsAuth !== true) throw error
      this.tokens.delete(entry.alias)
      token = await this.token(entry)
      return await send(token)
    }
  }

  // --------------------------------------------------------------- probes

  /** Probe reachability, version, credential and per-module scopes. */
  async test(alias, options = {}) {
    const entry = this.entry(alias)
    const result = {
      alias: entry.alias,
      kind: 'daidai',
      baseUrl: entry.baseUrl,
      reachable: false,
      version: undefined,
      auth: 'unknown',
      message: undefined,
    }
    try {
      // `/api/v1/version` is public; a legacy panel only answers `/api/version`.
      // `/version` is public: reachability must not depend on the credential,
      // or a wrong app_secret would look like a dead panel.
      let version
      try {
        version = await this.anonymous(alias, '/version')
      } catch (error) {
        if (!(error instanceof QinglongError) || error.status !== 404) throw error
        entry.apiPrefix = 'legacy'
        version = await this.anonymous(alias, '/version')
      }
      result.reachable = true
      if (typeof version?.version === 'string') result.version = version.version
    } catch (error) {
      result.auth = 'failed'
      result.message = errorMessage(error)
      return compact(result)
    }
    try {
      await this.call(alias, { path: '/tasks', query: { page: 1, page_size: 1 } })
      result.auth = 'ok'
      result.scopes = await this.probeScopes(alias, { force: options.refresh === true })
      return compact(result)
    } catch (error) {
      if (error instanceof QinglongError && error.forbidden === true) {
        result.auth = 'forbidden'
        result.message = `token 有效，但该应用缺少 tasks 权限：${error.message}`
        result.scopes = await this.probeScopes(alias, { force: options.refresh === true })
        return compact(result)
      }
      if (error instanceof QinglongError && error.needsAuth === true) {
        result.auth = 'required'
        result.message = errorMessage(error)
        return compact(result)
      }
      result.auth = 'failed'
      result.message = errorMessage(error)
      return compact(result)
    }
  }

  /**
   * Probe which modules this application may read. Daidai has no "list my
   * scopes" endpoint; each module answers 403 without its scope, which is the
   * same signal the panel's own MCP uses. The notification and backup scopes
   * are admin/user-token only for reads, so they are reported as `n/a`.
   */
  async probeScopes(alias, options = {}) {
    const entry = this.entry(alias)
    const fingerprint = credentialFingerprint(entry.auth)
    const cached = this.scopeCache.get(entry.alias)
    if (options.force !== true && cached !== undefined && cached.fingerprint === fingerprint && Date.now() - cached.at < 300_000) {
      return cached.scopes
    }
    const targets = {
      tasks: { path: '/tasks', query: { page: 1, page_size: 1 } },
      envs: { path: '/envs', query: { page: 1, page_size: 1 } },
      logs: { path: '/logs', query: { page: 1, page_size: 1 } },
      scripts: { path: '/scripts' },
      subscriptions: { path: '/subscriptions' },
      system: { path: '/system/info' },
      backup: { path: '/system/backups' },
      // `notifications` is deliberately not probed: its routes require a panel
      // user token (admin), so an application credential always gets 403 and
      // the result would say nothing about the app's scopes.
    }
    const probeTimeout = Math.min(entry.timeoutMs ?? this.timeoutMs, 12_000)
    const scopes = {}
    await Promise.all(Object.entries(targets).map(async ([name, target]) => {
      try {
        await this.call(alias, { ...target, timeoutMs: probeTimeout })
        scopes[name] = 'ok'
      } catch (error) {
        if (error instanceof QinglongError && error.forbidden === true) scopes[name] = 'forbidden'
        else if (error instanceof QinglongError && error.needsAuth === true) scopes[name] = 'auth'
        else scopes[name] = 'error'
      }
    }))
    this.scopeCache.set(entry.alias, { fingerprint, at: Date.now(), scopes })
    return scopes
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

  /** Create environment variables (Daidai accepts an array in one request). */
  async envsCreate(alias, envs) {
    const body = await this.call(alias, { method: 'POST', path: '/envs', body: envs.map(toDaidaiEnv) })
    return body
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
    if (Object.keys(body).length === 0) throw new QinglongError('没有可更新的环境变量字段')
    return await this.call(alias, { method: 'PUT', path: `/envs/${encodeURIComponent(String(id))}`, body })
  }

  /** Delete environment variables by id. */
  async envsRemove(alias, ids) {
    return await this.call(alias, { method: 'DELETE', path: '/envs/batch', body: { ids } })
  }

  /** Enable or disable environment variables by id. */
  async envsToggle(alias, action, ids) {
    if (action !== 'enable' && action !== 'disable') throw new QinglongError(`未知操作 '${action}'`)
    return await this.call(alias, { method: 'PUT', path: `/envs/batch/${action}`, body: { ids } })
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
    if (found === undefined) throw new QinglongError(`任务 ${id} 不存在`, { code: 404, status: 404 })
    return mapTask(found)
  }

  /** Create a scheduled task. */
  async cronsCreate(alias, cron) {
    return await this.call(alias, { method: 'POST', path: '/tasks', body: toDaidaiTask(cron) })
  }

  /** Update a scheduled task with a partial body. */
  async cronsUpdate(alias, id, patch) {
    const body = toDaidaiTaskPatch(patch)
    if (Object.keys(body).length === 0) throw new QinglongError('没有可更新的任务字段')
    return await this.call(alias, { method: 'PUT', path: `/tasks/${encodeURIComponent(String(id))}`, body })
  }

  /** Delete scheduled tasks by id (batch endpoint, `task_ids`). */
  async cronsRemove(alias, ids) {
    return await this.call(alias, { method: 'DELETE', path: '/tasks/batch/delete', body: { task_ids: ids } })
  }

  /**
   * Run / stop / enable / disable tasks. Daidai's batch run caps at 10 per
   * request, so larger selections are chunked; the other actions are per task.
   */
  async cronsAction(alias, action, ids) {
    if (!['run', 'stop', 'enable', 'disable'].includes(action)) throw new QinglongError(`未知操作 '${action}'`)
    const results = []
    if (action === 'run' && ids.length > 1) {
      for (let index = 0; index < ids.length; index += 10) {
        const chunk = ids.slice(index, index + 10)
        results.push(await this.call(alias, { method: 'POST', path: '/tasks/batch/run', body: { task_ids: chunk } }))
      }
      return results
    }
    for (const id of ids) {
      results.push(await this.call(alias, { method: 'PUT', path: `/tasks/${encodeURIComponent(String(id))}/${action}` }))
    }
    return results
  }

  /** Read the latest execution log of one task. */
  async cronsLog(alias, id, query) {
    const body = await this.call(alias, { path: `/tasks/${encodeURIComponent(String(id))}/latest-log` })
    const payload = typeof body?.data === 'object' && body.data !== null ? body.data : body
    const content = typeof payload?.content === 'string' ? payload.content : ''
    const limit = Number(query?.limit)
    const text = Number.isFinite(limit) && limit > 0 ? content.slice(-limit) : content
    return {
      data: text,
      logStatus: payload?.status,
      offset: 0,
      total: content.length,
      truncated: text.length !== content.length,
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
    return {
      times: Array.isArray(payload?.next_run_times) ? payload.next_run_times : [],
      description: payload?.description,
      format: payload?.format,
      valid: payload?.is_valid !== false,
      ...(payload?.error === undefined ? {} : { error: payload.error }),
    }
  }

  // -------------------------------------------------------------- generic

  /** Generic `/api/v1` call, used by the agent's bridge tool. */
  async raw(alias, options) {
    return await this.call(alias, options)
  }

  /** Public version endpoint without a credential (reachability probe). */
  async anonymous(alias, path) {
    const entry = this.entry(alias)
    const response = await httpRequest(entry.baseUrl + this.prefix(entry) + path, {
      timeoutMs: entry.timeoutMs ?? this.timeoutMs,
      insecureTls: entry.insecureTls,
    })
    return parseDaidaiResponse(response, `GET ${this.prefix(entry)}${path}`)
  }
}

/** Re-export for callers that only import this module. */
export { SCOPE_DENIED }
