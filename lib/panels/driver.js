/**
 * Shared panel driver: transport, credential cache and the probe skeleton that
 * every panel product reuses.
 *
 * One product adapter implements five wire hooks — `prefixFor`,
 * `authRequest`, `readToken`, `parseResponse`, `probeTargets` — plus its own
 * resource CRUD (`envs*` / `crons*`). Everything above that line exists once:
 * the token cache with in-flight de-duplication, the single 401 re-login, the
 * scope-probe skeleton, entry resolution and error normalization.
 *
 * Every failure is a {@link PanelError} carrying `kindLabel`, so the copy a
 * user sees names the right product without the caller knowing which one it
 * talked to.
 *
 * node:http/https is used directly instead of the global `fetch`: the DSH host
 * boots an undici dispatcher that strips content-encoding negotiation, and
 * this half needs explicit timeout, TLS and response-size control anyway.
 */

import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { errorLabelOf, kindMeta } from './kinds.js'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Response ceiling: a panel payload is JSON metadata, never a file body. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Refresh the token this long before its declared expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/** How long a scope probe stays authoritative. */
const SCOPE_CACHE_TTL_MS = 300_000

/** Ceiling for one entry of the scope probe (a probe must not stall the UI). */
const PROBE_TIMEOUT_MS = 12_000

/** One failure carrier shared by the routes and the agent tools. */
export class PanelError extends Error {
  /**
   * @param message - user-facing reason.
   * @param info - transport/business context.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'PanelError'
    /** HTTP status of the response, when there was one. */
    this.status = info.status
    /** Business code, when the product reports one. */
    this.code = info.code
    /** True when the panel rejected the credential and a re-login may help. */
    this.needsAuth = info.needsAuth === true
    /** True when the response body was not the expected JSON. */
    this.malformed = info.malformed === true
    /** True when the panel answered 403 (credential accepted, scope missing). */
    this.forbidden = info.forbidden === true
    /** Product name for error copy ("青龙面板", "呆呆面板"). */
    this.kindLabel = info.kindLabel
  }
}

/** Encode a query object: arrays repeat the key, empty values are dropped. */
/**
 * Join a panel-relative directory and a file name with single slashes.
 * @param dir - directory, '' for the scripts root.
 * @param file - file name.
 * @returns the panel-relative path.
 */
export function joinScriptPath(...parts) {
  return parts
    .filter(part => typeof part === 'string' && part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

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
  if (error instanceof PanelError) {
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

/**
 * Human-readable message from an unknown thrown value, naming the product the
 * failure came from (`error.kindLabel`, set by the driver that threw it).
 * @param error - the thrown value.
 * @returns the message to show.
 */
export function errorMessage(error) {
  if (error instanceof PanelError) return error.message
  const label = typeof error?.kindLabel === 'string' && error.kindLabel !== '' ? error.kindLabel : '面板'
  if (error instanceof Error) {
    if (/timed out/i.test(error.message)) return `请求${label}超时，请检查地址与网络。`
    if (/ECONNREFUSED/.test(error.message)) return `无法连接${label}（连接被拒绝），请检查地址与端口。`
    if (/ENOTFOUND|EAI_AGAIN/.test(error.message)) return `无法解析${label}地址，请检查域名。`
    if (/certificate|self.signed|SELF_SIGNED/i.test(error.message)) return `${label}的 TLS 证书不受信任；如是自签证书，请在主机设置里开启"跳过证书校验"。`
    return error.message
  }
  return String(error)
}

/**
 * One product adapter's shared half. Instances are per plugin mount and per
 * product; the engine owns one of each.
 */
export class PanelDriver {
  /**
   * @param store - the panel store.
   * @param options - `kind` (product id) and the request timeout.
   */
  constructor(store, options = {}) {
    this.store = store
    this.kind = options.kind
    const meta = kindMeta(this.kind)
    /** Short badge text. */
    this.label = meta?.label ?? this.kind
    /** Product name used in error copy. */
    this.errorLabel = errorLabelOf(this.kind)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    /** alias -> { token, expiresAt, fingerprint } */
    this.tokens = new Map()
    /** alias -> in-flight token acquisition, so concurrent calls share one login. */
    this.logins = new Map()
    /** alias -> { fingerprint, at, scopes }: last read-probe of the app's scopes. */
    this.scopes = new Map()
    /** alias -> 'legacy' when the panel only answers the old prefix. */
    this.prefixes = new Map()
  }

  /** Apply a new default request timeout (settings edit without a remount). */
  setRequestTimeout(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) this.timeoutMs = ms
  }

  /** Drop every cached value for one panel (credential change, panel removal). */
  dropAlias(alias) {
    this.tokens.delete(alias)
    this.logins.delete(alias)
    this.scopes.delete(alias)
    this.prefixes.delete(alias)
  }

  /** Forget every cached value (plugin unload). */
  dispose() {
    this.tokens.clear()
    this.logins.clear()
    this.scopes.clear()
    this.prefixes.clear()
  }

  /**
   * Resolve the panel an operation addresses.
   * @param alias - requested alias, or undefined for the default panel.
   * @returns the stored entry.
   * @throws PanelError when no panel matches.
   */
  entry(alias) {
    if (typeof alias === 'string' && alias !== '') {
      const found = this.store.find(alias)
      if (found === undefined) throw this.fail(`panel '${alias}' 不存在`, { code: 404, status: 404 })
      return found
    }
    const fallback = this.store.defaultAlias()
    const found = fallback === undefined ? undefined : this.store.find(fallback)
    if (found === undefined) {
      throw this.fail(`尚未配置${this.errorLabel}，请先在「主机」页签新增一个。`, { code: 404, status: 404 })
    }
    return found
  }

  /** Build a failure that names this product. */
  fail(message, info = {}) {
    return new PanelError(message, { kindLabel: this.errorLabel, ...info })
  }

  /** Fingerprint the credential a cached token belongs to. */
  fingerprint(auth) {
    const material = auth.kind === 'open'
      ? `${this.kind}:${auth.appKey}:${auth.appSecret}`
      : `token:${auth.token}`
    return createHash('sha256').update(material).digest('hex')
  }

  // ------------------------------------------------------------ transport

  /** One HTTP exchange, tagging transport failures with this product's name. */
  async send(entry, url, options) {
    try {
      return await httpRequest(url, options)
    } catch (error) {
      if (error instanceof Error && typeof error.kindLabel !== 'string') error.kindLabel = this.errorLabel
      throw error
    }
  }

  /**
   * Perform one call and return the parsed envelope.
   * @param alias - panel alias (undefined = default panel).
   * @param options - method, path (relative to the product prefix), query, body.
   * @returns the parsed body.
   */
  async call(alias, options) {
    const entry = this.entry(alias)
    const prefix = this.prefixFor(entry)
    const method = (options.method ?? 'GET').toUpperCase()
    const path = options.path.startsWith('/') ? options.path : '/' + options.path
    const url = entry.baseUrl + prefix + path + encodeQuery(options.query)
    const timeoutMs = options.timeoutMs ?? entry.timeoutMs ?? this.timeoutMs
    const once = async token => {
      const response = await this.send(entry, url, {
        method,
        headers: { ...this.authHeaders(token), ...this.extraHeaders(options) },
        body: options.body,
        timeoutMs,
        insecureTls: entry.insecureTls,
      })
      return this.parseResponse(response, `${method} ${prefix}${path}`)
    }
    let token = await this.token(entry)
    try {
      return await once(token)
    } catch (error) {
      if (!(error instanceof PanelError) || entry.auth.kind === 'token' || options.retryOnAuth === false) throw error
      if (error.needsAuth !== true) throw error
      // The cached token was rejected: drop it and retry exactly once.
      this.tokens.delete(entry.alias)
      token = await this.token(entry)
      return await once(token)
    }
  }

  /**
   * Perform one call and return its `data`.
   * @param alias - panel alias.
   * @param options - as {@link call}.
   * @returns the body's `data` (undefined when absent).
   */
  async data(alias, options) {
    const body = await this.call(alias, options)
    const value = body?.data
    // A panel that answers 200 with an empty body leaves `data` undefined, and
    // `undefined` is not JSON: the host rejects the whole tool result.
    return value === undefined ? null : value
  }

  /**
   * Call one public endpoint without a credential (the token handshake is a
   * separate failure mode from reachability).
   * @param alias - panel alias.
   * @param path - path relative to the product prefix.
   * @returns the parsed body.
   */
  async anonymous(alias, path) {
    const entry = this.entry(alias)
    const prefix = this.prefixFor(entry)
    const response = await this.send(entry, entry.baseUrl + prefix + path, {
      timeoutMs: entry.timeoutMs ?? this.timeoutMs,
      insecureTls: entry.insecureTls,
    })
    return this.parseResponse(response, `GET ${prefix}${path}`)
  }

  /**
   * Generic call used by the agent's bridge tool.
   * @param alias - panel alias.
   * @param options - as {@link call}.
   */
  async raw(alias, options) {
    return await this.call(alias, options)
  }

  // ------------------------------------------------------------- auth

  /**
   * Authentication headers for one panel.
   *
   * Products disagree on the wire form: 青龙 and 呆呆 present a bearer token,
   * A product that authenticates with a header other than `Authorization`
   * overrides this. Caching and the single
   * retry on a rejected token stay shared.
   * @param token - the token to present.
   * @returns a header map.
   */
  authHeaders(token) {
    return { authorization: `Bearer ${token}` }
  }

  /**
   * Acquire (or reuse) the bearer token for one panel.
   * @param entry - stored panel entry.
   * @returns the token string.
   */
  async token(entry) {
    if (entry.auth.kind === 'token') return entry.auth.token
    const fingerprint = this.fingerprint(entry.auth)
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
   * Run the product handshake and cache the token it returns.
   * @param entry - stored panel entry.
   * @param fingerprint - credential identity the token belongs to.
   * @returns the token string.
   */
  async login(entry, fingerprint) {
    const request = this.authRequest(entry)
    const response = await this.send(entry, request.url, {
      method: request.method ?? 'GET',
      body: request.body,
      timeoutMs: entry.timeoutMs ?? this.timeoutMs,
      insecureTls: entry.insecureTls,
    })
    let body
    try {
      body = this.parseResponse(response, request.label)
    } catch (error) {
      // A token-endpoint rejection is a credential problem, not a transport
      // failure: the probe reports it as "credential rejected" so the user
      // edits the key pair instead of the URL.
      if (!(error instanceof PanelError)) throw error
      throw new PanelError(error.message, {
        status: error.status,
        code: error.code,
        needsAuth: true,
        forbidden: error.forbidden === true,
        kindLabel: this.errorLabel,
      })
    }
    const { token, expiresAt } = this.readToken(body, response)
    this.tokens.set(entry.alias, { token, expiresAt, fingerprint })
    return token
  }

  // ------------------------------------------------------------ probes

  /**
   * Probe one panel: reachability, version, and credential/scope state.
   * @param alias - panel alias.
   * @param options - `refresh` forces a new scope probe.
   * @returns the probe result.
   */
  async test(alias, options = {}) {
    const entry = this.entry(alias)
    const result = {
      alias: entry.alias,
      kind: this.kind,
      baseUrl: entry.baseUrl,
      reachable: false,
      version: undefined,
      auth: 'unknown',
      message: undefined,
    }
    try {
      // The version endpoint is public: reachability and version must not
      // depend on the credential, or a bad secret would look like a dead panel.
      result.version = await this.connect(alias, entry)
      result.reachable = true
    } catch (error) {
      result.auth = 'failed'
      result.message = errorMessage(error)
      return compact(result)
    }
    const force = options.refresh === true
    try {
      // The cheapest scope this plugin's UI needs; a 403 here still proves the
      // token itself was accepted.
      await this.data(alias, this.cheapestRead())
    } catch (error) {
      if (error instanceof PanelError && (error.forbidden === true || error.code === 403)) {
        result.auth = 'forbidden'
        result.message = this.forbiddenMessage(error)
        result.scopes = await this.probeScopes(alias, { force })
        return compact(result)
      }
      if (error instanceof PanelError && (error.needsAuth === true || error.code === 401)) {
        result.auth = 'required'
        result.message = errorMessage(error)
        return compact(result)
      }
      result.auth = 'failed'
      result.message = errorMessage(error)
      return compact(result)
    }
    result.auth = 'ok'
    result.scopes = await this.probeScopes(alias, { force })
    return compact(result)
  }

  /**
   * Probe which resources this application may read.
   *
   * No product exposes "list my scopes", so each resource named by
   * {@link probeTargets} gets one cheap read: 200 means the scope is present,
   * 403 means it is missing. The skeleton is shared; what to probe is not.
   * @param alias - panel alias.
   * @param options - `force` ignores the cached map.
   * @returns resource name -> 'ok' | 'forbidden' | 'auth' | 'timeout' | 'error'.
   */
  async probeScopes(alias, options = {}) {
    const entry = this.entry(alias)
    const fingerprint = this.fingerprint(entry.auth)
    const cached = this.scopes.get(entry.alias)
    if (options.force !== true && cached !== undefined && cached.fingerprint === fingerprint && Date.now() - cached.at < SCOPE_CACHE_TTL_MS) {
      return cached.scopes
    }
    const probeTimeout = Math.min(entry.timeoutMs ?? this.timeoutMs, PROBE_TIMEOUT_MS)
    const scopes = {}
    await Promise.all(Object.entries(this.probeTargets(entry)).map(async ([name, target]) => {
      try {
        await this.data(alias, { ...target, timeoutMs: probeTimeout })
        scopes[name] = 'ok'
      } catch (error) {
        scopes[name] = classifyProbeError(error)
      }
    }))
    // Resources that are too slow or too special for the parallel batch.
    const extra = await this.probeExtra(alias, entry, probeTimeout)
    if (extra !== undefined) Object.assign(scopes, extra)
    this.scopes.set(entry.alias, { fingerprint, at: Date.now(), scopes })
    return scopes
  }

  // -------------------------------------------------------------- hooks
  // A product adapter implements these; nothing above needs to change.

  /** Wire prefix this product answers on (`/open`, `/api/v1`). */
  prefixFor() {
    throw new Error(`${this.kind} adapter must implement prefixFor()`)
  }

  /** Credential handshake request: `{ url, method, body?, label }`. */
  authRequest() {
    throw new Error(`${this.kind} adapter must implement authRequest()`)
  }

  /** Read `{ token, expiresAt }` out of a handshake response body. */
  readToken() {
    throw new Error(`${this.kind} adapter must implement readToken()`)
  }

  /** Turn one HTTP response into the parsed body or a {@link PanelError}. */
  parseResponse() {
    throw new Error(`${this.kind} adapter must implement parseResponse()`)
  }

  /** `{ name: { path, query? } }` — one cheap read per resource. */
  probeTargets() {
    throw new Error(`${this.kind} adapter must implement probeTargets()`)
  }

  /** Read the public version endpoint (reachability probe). */
  async connect(alias) {
    const body = await this.anonymous(alias, '/version')
    return typeof body?.version === 'string' ? body.version : undefined
  }

  /** The cheapest resource read that still proves the credential works. */
  cheapestRead() {
    throw new Error(`${this.kind} adapter must implement cheapestRead()`)
  }

  /**
   * List the code files under one directory.
   *
   * The default is the 青龙 shape: `GET /scripts` scoped by `path`. Products
   * that keep code elsewhere (a product may expose a file API rather than a
   * script API)
   * override this and normalise their own rows.
   * @param alias - panel alias.
   * @param dir - panel-relative directory, '' for the root.
   * @returns the parsed envelope.
   */
  async scriptsList(alias, dir) {
    return await this.call(alias, { method: 'GET', path: '/scripts', query: { path: dir } })
  }

  /**
   * Read one code file. 青龙 wants `path` + `file`, 呆呆 a single joined path.
   * @param alias - panel alias.
   * @param dir - panel-relative directory.
   * @param file - file name.
   * @returns the parsed envelope.
   */
  async scriptsRead(alias, dir, file) {
    return await this.call(alias, { method: 'GET', path: '/scripts/detail', query: { path: dir, file } })
  }

  /**
   * Create-or-update one code file.
   *
   * 青龙 splits the two verbs: PUT rewrites a file that exists and answers 404
   * 脚本不存在 otherwise, POST creates it. Guessing one verb gets a 404 on half
   * of the pushes, so both are tried here.
   * @param alias - panel alias.
   * @param dir - panel-relative directory.
   * @param file - file name.
   * @param content - full file text.
   * @returns the parsed envelope.
   */
  async scriptsWrite(alias, dir, file, content) {
    const body = { filename: file, path: dir, content }
    try {
      return await this.call(alias, { method: 'PUT', path: '/scripts', body })
    } catch (error) {
      const missing = error instanceof PanelError && (error.code === 404 || /脚本不存在/.test(error.message))
      if (!missing) throw error
      return await this.call(alias, { method: 'POST', path: '/scripts', body })
    }
  }

  /**
   * Run one code file.
   * @param alias - panel alias.
   * @param dir - panel-relative directory.
   * @param file - file name.
   * @returns the parsed envelope.
   */
  async scriptsRun(alias, dir, file) {
    return await this.call(alias, { method: 'PUT', path: '/scripts/run', body: { filename: file, path: dir } })
  }

  /** Copy for "token accepted, scope missing". */
  forbiddenMessage() {
    return 'token 有效，但该应用缺少读取该资源的权限'
  }

  /** Scopes probed outside the parallel batch, or undefined. */
  async probeExtra() {
    return undefined
  }

  /** Extra headers for one call (idempotency keys and the like). */
  extraHeaders() {
    return {}
  }
}
