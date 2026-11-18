/**
 * Qinglong OpenAPI client.
 *
 * Every call goes to `<baseUrl>/open/<path>` with `Authorization: Bearer …`.
 * The token is an application access token: obtained once from
 * `GET /open/auth/token?client_id=&client_secret=` (response carries
 * `data.token` and `data.expiration`, a Unix **second** timestamp), cached in
 * memory per panel, refreshed ahead of expiry, and re-acquired exactly once
 * when a request reports the token as invalid. A panel entry may also carry a
 * pasted token, which is used verbatim and never refreshed.
 *
 * Qinglong answers most business failures with HTTP 200 and a JSON envelope
 * `{ code, message }` where `code` is 400/401/403/…, so `code` — not the HTTP
 * status alone — decides success. Every failure is normalized into
 * {@link QinglongError} so both callers (routes and agent tools) report one
 * message shape.
 *
 * node:http/https is used directly instead of the global `fetch`: the DSH host
 * boots an undici dispatcher that strips content-encoding negotiation, and
 * this half needs explicit timeout, TLS and response-size control anyway.
 */

import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { OPEN_PREFIX } from './protocol.js'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Response ceiling: a panel payload is JSON metadata, never a file body. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Refresh the token this long before its declared expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/** One failure carrier shared by both callers. */
export class QinglongError extends Error {
  /**
   * @param message - user-facing reason.
   * @param info - transport/business context.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'QinglongError'
    /** HTTP status of the response, when there was one. */
    this.status = info.status
    /** Qinglong business code from the JSON envelope, when present. */
    this.code = info.code
    /** True when the panel rejected the credential and a re-login may help. */
    this.needsAuth = info.needsAuth === true
    /** True when the response body was not JSON. */
    this.malformed = info.malformed === true
    /** True when the panel answered 403 (credential accepted, scope missing). */
    this.forbidden = info.forbidden === true
  }
}

/** Encode a query object: arrays repeat the key, empty values are dropped. */
export function encodeQuery(query) {
  if (query === undefined || query === null) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue
        search.append(key, String(item))
      }
    } else {
      search.set(key, String(value))
    }
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/**
 * Perform one HTTP exchange against a panel.
 * @param url - absolute URL.
 * @param opts - method, headers, JSON body, timeout, TLS policy.
 * @returns status, headers and the decoded text body.
 */
export function httpRequest(url, opts) {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), 'utf8')
  const headers = { accept: 'application/json', 'accept-encoding': 'identity', ...opts.headers }
  if (payload !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8'
    headers['content-length'] = String(payload.length)
  }
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? undefined : target.port,
      path: target.pathname + target.search,
      method: opts.method ?? 'GET',
      headers,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: opts.insecureTls !== true } : {}),
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('panel response too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', error => reject(error))
    })
    request.setTimeout(opts.timeoutMs, () => {
      const timeout = new Error(`request timed out after ${opts.timeoutMs} ms`)
      timeout.code = 'ETIMEDOUT'
      request.destroy(timeout)
    })
    request.on('error', error => reject(error))
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

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

/** Whether a JSON envelope reports a permission problem. */
function isForbiddenFailure(status, body) {
  if (status === 403) return true
  const code = typeof body === 'object' && body !== null ? body.code : undefined
  return code === 403
}

/** Fingerprint the credential a cached token belongs to. */
function credentialFingerprint(auth) {
  const material = auth.kind === 'open'
    ? `open:${auth.appKey}:${auth.appSecret}`
    : `token:${auth.token}`
  return createHash('sha256').update(material).digest('hex')
}

/**
 * The engine: one instance per plugin mount, shared by the HTTP routes and the
 * agent tools so a panel managed in one place is immediately operable in the
 * other.
 */
export class QinglongEngine {
  /**
   * @param store - the panel store.
   * @param options - request timeout.
   */
  constructor(store, options = {}) {
    this.store = store
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    /** alias -> { token, expiresAt, fingerprint } */
    this.tokens = new Map()
    /** alias -> in-flight token acquisition, so concurrent calls share one login. */
    this.logins = new Map()
    /** alias -> { fingerprint, at, scopes }: last read-probe of the app's scopes. */
    this.scopes = new Map()
  }

  /** Apply a new default request timeout (settings edit without a remount). */
  setRequestTimeout(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) this.timeoutMs = ms
  }

  /** Drop any cached token for one panel (credential change, panel removal). */
  dropAlias(alias) {
    this.tokens.delete(alias)
    this.logins.delete(alias)
    this.scopes.delete(alias)
  }

  /** Forget every cached token (plugin unload). */
  dispose() {
    this.tokens.clear()
    this.logins.clear()
    this.scopes.clear()
  }

  /**
   * Resolve the panel an operation addresses.
   * @param alias - requested alias, or undefined for the default panel.
   * @returns the stored entry.
   * @throws QinglongError when no panel matches.
   */
  entry(alias) {
    if (typeof alias === 'string' && alias !== '') {
      const found = this.store.find(alias)
      if (found === undefined) throw new QinglongError(`panel '${alias}' 不存在`, { code: 404, status: 404 })
      return found
    }
    const fallback = this.store.defaultAlias()
    if (fallback === undefined) throw new QinglongError('尚未配置青龙面板，请先在「主机」页签新增一个。', { code: 404, status: 404 })
    const found = this.store.find(fallback)
    if (found === undefined) throw new QinglongError('尚未配置青龙面板，请先在「主机」页签新增一个。', { code: 404, status: 404 })
    return found
  }

  /**
   * Acquire (or reuse) the bearer token for one panel.
   * @param entry - stored panel entry.
   * @returns the token string.
   */
  async token(entry) {
    if (entry.auth.kind === 'token') return entry.auth.token
    const fingerprint = credentialFingerprint(entry.auth)
    const cached = this.tokens.get(entry.alias)
    if (cached !== undefined && cached.fingerprint === fingerprint && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
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

  /**
   * Obtain a fresh application token from `GET /open/auth/token`.
   * @param entry - stored panel entry.
   * @param fingerprint - credential identity the token belongs to.
   * @returns the token string.
   */
  async login(entry, fingerprint) {
    const response = await httpRequest(
      `${entry.baseUrl}${OPEN_PREFIX}/auth/token` + encodeQuery({
        client_id: entry.auth.appKey,
        client_secret: entry.auth.appSecret,
      }),
      { timeoutMs: entry.timeoutMs ?? this.timeoutMs, insecureTls: entry.insecureTls },
    )
    let body
    try {
      body = parseEnvelope(response, '获取应用 token')
    } catch (error) {
      // A token-endpoint rejection is a credential problem, not a transport
      // failure: the probe reports it as "credential rejected" so the user
      // edits client_id / client_secret instead of the URL.
      if (error instanceof QinglongError) {
        throw new QinglongError(error.message, { status: error.status, code: error.code, needsAuth: true })
      }
      throw error
    }
    const data = body.data
    if (typeof data !== 'object' || data === null || typeof data.token !== 'string' || data.token === '') {
      throw new QinglongError('青龙返回的 token 响应缺少 data.token', { status: response.status, code: body.code })
    }
    const expiration = typeof data.expiration === 'number' ? data.expiration : undefined
    this.tokens.set(entry.alias, {
      token: data.token,
      // No expiration declared: refresh after a conservative hour.
      expiresAt: expiration === undefined ? Date.now() + 3_600_000 : expiration * 1000,
      fingerprint,
    })
    return data.token
  }

  /**
   * Perform one OpenAPI call.
   * @param alias - panel alias (undefined = default panel).
   * @param options - method, path (relative to /open), query, JSON body.
   * @returns the parsed JSON envelope.
   */
  async call(alias, options) {
    const entry = this.entry(alias)
    const method = (options.method ?? 'GET').toUpperCase()
    const path = options.path.startsWith('/') ? options.path : '/' + options.path
    const url = entry.baseUrl + OPEN_PREFIX + path + encodeQuery(options.query)
    const timeoutMs = options.timeoutMs ?? entry.timeoutMs ?? this.timeoutMs
    const send = async (token) => {
      const headers = {
        authorization: `Bearer ${token}`,
        ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
      }
      const response = await httpRequest(url, {
        method,
        headers,
        body: options.body,
        timeoutMs,
        insecureTls: entry.insecureTls,
      })
      return parseEnvelope(response, `${method} ${OPEN_PREFIX}${path}`)
    }
    let token = await this.token(entry)
    try {
      return await send(token)
    } catch (error) {
      if (!(error instanceof QinglongError) || entry.auth.kind === 'token' || options.retryOnAuth === false) throw error
      if (!error.needsAuth) throw error
      // The cached token was rejected: drop it and retry exactly once.
      this.tokens.delete(entry.alias)
      token = await this.token(entry)
      return await send(token)
    }
  }

  /**
   * Perform one call and return `data`.
   * @param alias - panel alias.
   * @param options - as {@link call}.
   * @returns the envelope's `data` (undefined when absent).
   */
  async data(alias, options) {
    const body = await this.call(alias, options)
    return body.data
  }

  // --------------------------------------------------------------- probes

  /**
   * Probe one panel: reachability, version, and credential/scope state.
   * @param alias - panel alias.
   * @returns the probe result.
   */
  async test(alias, options = {}) {
    const entry = this.entry(alias)
    const result = {
      alias: entry.alias,
      baseUrl: entry.baseUrl,
      reachable: false,
      version: undefined,
      auth: 'unknown',
      message: undefined,
    }
    try {
      // /open/system is public: reachability and version must not depend on
      // the application credential, or a bad secret would look like a dead
      // panel.
      const envelope = await this.anonymous(alias, '/system')
      const system = envelope.data
      result.reachable = true
      if (typeof system === 'object' && system !== null && typeof system.version === 'string') {
        result.version = system.version
      }
    } catch (error) {
      result.auth = 'failed'
      result.message = errorMessage(error)
      return compact(result)
    }
    try {
      // /envs is the cheapest scope this plugin's UI needs; a 403 here still
      // proves the token itself was accepted.
      await this.data(alias, { path: '/envs', query: { searchValue: '__dsh_probe__' } })
      result.auth = 'ok'
      result.scopes = await this.probeScopes(alias, { force: options.refresh === true })
      return compact(result)
    } catch (error) {
      if (error instanceof QinglongError && error.code === 403) {
        result.auth = 'forbidden'
        result.message = 'token 有效，但该应用缺少 envs 权限'
        // The token itself is accepted, so the per-resource map is meaningful.
        result.scopes = await this.probeScopes(alias, { force: options.refresh === true })
        return compact(result)
      }
      if (error instanceof QinglongError && (error.needsAuth || error.code === 401)) {
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
   * Probe which OpenAPI resources this application may read.
   *
   * Qinglong exposes no "list my scopes" endpoint (`GET /open/apps` needs the
   * apps scope and returns secrets), so each resource gets one cheap read:
   * 200 means the scope is present, 403 means it is missing. Writes share the
   * same scope namespace (`crons:read` also excludes the mutating
   * `GET /crons/import`), so this is the same signal `ql auth status` uses.
   * @param alias - panel alias.
   * @returns resource name -> 'ok' | 'forbidden' | 'auth' | 'error' | 'public'.
   */
  /**
   * Probe the `dependencies` scope without paying for a full scan.
   *
   * `GET /dependencies` walks every runtime (measured 10-16 s on a real panel);
   * the same route answers `?type=python3` in under a second. Try the filter
   * first, then fall back to the unfiltered list with a generous ceiling for
   * panels that do not support it.
   * @param alias - panel alias.
   * @param entry - stored panel entry.
   * @returns the probe state for this resource.
   */
  async probeDependencies(alias, entry) {
    const base = entry.timeoutMs ?? this.timeoutMs
    try {
      await this.data(alias, {
        path: '/dependencies',
        query: { type: 'python3' },
        timeoutMs: Math.min(base, 8_000),
      })
      return 'ok'
    } catch (error) {
      const state = classifyProbeError(error)
      if (state === 'forbidden' || state === 'auth') return state
    }
    try {
      await this.data(alias, { path: '/dependencies', timeoutMs: Math.max(base, 25_000) })
      return 'ok'
    } catch (error) {
      return classifyProbeError(error)
    }
  }

  async probeScopes(alias, options = {}) {
    const entry = this.entry(alias)
    const fingerprint = credentialFingerprint(entry.auth)
    const cached = this.scopes.get(entry.alias)
    if (options.force !== true && cached !== undefined && cached.fingerprint === fingerprint && Date.now() - cached.at < 300_000) {
      return cached.scopes
    }
    // Fast resources probe in parallel; `dependencies` is handled on its own
    // afterwards (see probeDependencies) because a full scan is slow.
    const fastTargets = {
      envs: { path: '/envs', query: { searchValue: '__dsh_probe__' } },
      crons: { path: '/crons', query: { page: 1, size: 1 } },
      subscriptions: { path: '/subscriptions' },
      configs: { path: '/configs/files' },
      scripts: { path: '/scripts' },
      logs: { path: '/logs' },
      dashboard: { path: '/dashboard/overview' },
    }
    const probeTimeout = Math.min(entry.timeoutMs ?? this.timeoutMs, 12_000)
    const scopes = {}
    await Promise.all(Object.entries(fastTargets).map(async ([name, target]) => {
      try {
        await this.data(alias, { ...target, timeoutMs: probeTimeout })
        scopes[name] = 'ok'
      } catch (error) {
        scopes[name] = classifyProbeError(error)
      }
    }))
    scopes.dependencies = await this.probeDependencies(alias, entry)
    try {
      await this.anonymous(alias, '/system')
      scopes.system = 'public'
    } catch {
      scopes.system = 'error'
    }
    this.scopes.set(entry.alias, { fingerprint, at: Date.now(), scopes })
    return scopes
  }

  /** System info (`GET /open/system`, no scope beyond system). */
  async system(alias) {
    return await this.data(alias, { path: '/system' })
  }

  /**
   * Call one public endpoint without a credential (the token handshake is a
   * separate failure mode from reachability).
   * @param alias - panel alias.
   * @param path - path relative to /open.
   * @returns the parsed envelope.
   */
  async anonymous(alias, path) {
    const entry = this.entry(alias)
    const response = await httpRequest(entry.baseUrl + OPEN_PREFIX + path, {
      timeoutMs: entry.timeoutMs ?? this.timeoutMs,
      insecureTls: entry.insecureTls,
    })
    return parseEnvelope(response, `GET ${OPEN_PREFIX}${path}`)
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
    if (typeof name !== 'string' || name === '') throw new QinglongError('环境变量名称不能为空')
    if (typeof value !== 'string') throw new QinglongError('环境变量值不能为空')
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
    if (action !== 'enable' && action !== 'disable') throw new QinglongError(`未知操作 '${action}'`)
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
    return await this.data(alias, { method: 'POST', path: '/crons', body: cron })
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
    if (typeof current !== 'object' || current === null) throw new QinglongError(`任务 ${id} 不存在`)
    const next = { ...current, ...patch, id: Number(id) }
    if (typeof next.command !== 'string' || next.command.trim() === '') throw new QinglongError('任务命令不能为空')
    if (typeof next.schedule !== 'string' || next.schedule.trim() === '') throw new QinglongError('定时规则不能为空')
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
    return await this.data(alias, { method: 'PUT', path: '/crons', body })
  }

  /** Delete scheduled tasks by id. */
  async cronsRemove(alias, ids) {
    return await this.data(alias, { method: 'DELETE', path: '/crons', body: ids })
  }

  /**
   * Run, stop, enable or disable scheduled tasks.
   * @param alias - panel alias.
   * @param action - run | stop | enable | disable.
   * @param ids - task ids.
   */
  async cronsAction(alias, action, ids) {
    if (!['run', 'stop', 'enable', 'disable'].includes(action)) throw new QinglongError(`未知操作 '${action}'`)
    const options = { method: 'PUT', path: `/crons/${action}`, body: ids }
    if (action === 'stop') {
      // A retried stop must address the same accepted instances (panel docs).
      options.idempotencyKey = globalThis.crypto.randomUUID()
    }
    return await this.data(alias, options)
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
    return await this.data(alias, { path: '/crons/preview', query: { schedule } })
  }

  // -------------------------------------------------------------- generic

  /**
   * Generic OpenAPI call, used by the agent tool for the resources the UI does
   * not cover.
   * @param alias - panel alias.
   * @param options - method, `/open`-relative path, query, body.
   */
  async raw(alias, options) {
    return await this.call(alias, options)
  }
}

/**
 * Parse one HTTP response into a Qinglong JSON envelope.
 * @param response - status/text from the transport.
 * @param what - operation label for the error message.
 * @returns the parsed envelope.
 * @throws QinglongError on a non-JSON body, an HTTP error, or `code !== 200`.
 */
function parseEnvelope(response, what) {
  let body
  try {
    body = JSON.parse(response.text)
  } catch {
    const snippet = response.text.replace(/\s+/g, ' ').slice(0, 200)
    throw new QinglongError(
      `${what} 返回了非 JSON 响应（HTTP ${response.status}）${snippet === '' ? '' : ': ' + snippet}`,
      { status: response.status, malformed: true, needsAuth: response.status === 401 },
    )
  }
  const code = typeof body === 'object' && body !== null && typeof body.code === 'number' ? body.code : undefined
  if (code !== undefined && code !== 200) {
    throw new QinglongError(
      messageOf(body) ?? `${what} 失败（code ${code}）`,
      {
        status: response.status,
        code,
        needsAuth: isAuthFailure(response.status, body),
      },
    )
  }
  if (response.status >= 400) {
    throw new QinglongError(
      messageOf(body) ?? `${what} 失败（HTTP ${response.status}）`,
      {
        status: response.status,
        code,
        needsAuth: response.status === 401,
      },
    )
  }
  return body
}

/**
 * Classify one failed scope probe.
 *
 * A 403 means the credential is fine and the scope is missing; a 401 means the
 * credential was rejected; a timeout says nothing about permission at all and
 * must not be shown as "no permission".
 * @param error - the thrown value.
 * @returns 'forbidden' | 'auth' | 'timeout' | 'error'.
 */
export function classifyProbeError(error) {
  if (error instanceof QinglongError) {
    if (error.forbidden === true || error.code === 403) return 'forbidden'
    if (error.needsAuth === true || error.code === 401) return 'auth'
  }
  const code = typeof error === 'object' && error !== null ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ETIMEDOUT' || /timed out|ETIMEDOUT/i.test(message)) return 'timeout'
  return 'error'
}

/**
 * Drop `undefined` properties: a tool result is validated as lossless JSON,
 * where an undefined value is not representable.
 * @param value - plain object.
 * @returns a copy without undefined-valued keys.
 */
export function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error) {
  if (error instanceof QinglongError) return error.message
  if (error instanceof Error) {
    if (/timed out/i.test(error.message)) return '请求青龙面板超时，请检查地址与网络。'
    if (/ECONNREFUSED/.test(error.message)) return '无法连接青龙面板（连接被拒绝），请检查地址与端口。'
    if (/ENOTFOUND|EAI_AGAIN/.test(error.message)) return '无法解析青龙面板地址，请检查域名。'
    if (/certificate|self.signed|SELF_SIGNED/i.test(error.message)) return '青龙面板的 TLS 证书不受信任；如是自签证书，请在主机设置里开启"跳过证书校验"。'
    return error.message
  }
  return String(error)
}

/** Whether a thrown value is a permission (not credential) failure. */
export function isForbidden(error) {
  return error instanceof QinglongError && isForbiddenFailure(error.status, { code: error.code })
}
