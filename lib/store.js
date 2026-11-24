/**
 * Panel connection store: one JSON file (`$DSH_HOME/dsh-cronops.json`,
 * defaulting to `~/.dsh`) holding every Qinglong panel the user configured,
 * written atomically (tmp + rename, mode 0600).
 *
 * Secrets (application client_secret, pasted bearer token) live in this
 * user-owned file in plaintext — the same trust model as the SSH host store.
 * They are never returned to the browser or to an agent: `summarize()` is the
 * only projection.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { PANEL_KINDS } from './panels/kinds.js'

/** File format version. */
const FORMAT_VERSION = 1

/** Alias grammar: letters/digits plus dots, hyphens, underscores. */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Panel products this store knows about (one source: `panels/kinds.js`). */
export { PANEL_KINDS }

/** Fields whose change invalidates a cached probe and any cached token. */
export const INVALIDATING_FIELDS = ['kind', 'baseUrl', 'auth', 'insecureTls', 'timeoutMs']

/** Request-timeout bounds accepted from the browser and the agent. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000

/**
 * Resolve the DSH home directory (`DSH_HOME`, else `<home>/.dsh`).
 * @param env - environment to read.
 * @param home - platform home fallback (tests).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw === '') return join(home, '.dsh')
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2))
  return resolve(raw)
}

/** Store file location: `$DSH_HOME/dsh-cronops.json`. */
export function storePath() {
  return join(resolveDshHome(), 'dsh-cronops.json')
}

/**
 * Normalize a panel base URL: trim, require http/https, strip trailing
 * slashes. A base URL that already ends in `/open` loses that suffix, because
 * every call appends the OpenAPI prefix itself.
 * @param raw - user input.
 * @returns the normalized base URL.
 * @throws Error when the value is not an http(s) URL.
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('baseUrl is required')
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('baseUrl must be an absolute http:// or https:// URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must be an absolute http:// or https:// URL')
  }
  if (url.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/open')) {
    url.pathname = url.pathname.replace(/\/+$/, '').slice(0, -'/open'.length)
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}` + (url.search === '' ? '' : url.search)
}

/** Validate an alias for creation. */
export function validateAlias(alias) {
  if (typeof alias !== 'string' || alias.trim() === '') return 'alias is required'
  if (!ALIAS_RE.test(alias.trim())) return 'alias must be letters, digits, dots, hyphens or underscores'
  return undefined
}

/**
 * Validate one auth block.
 * @param auth - raw auth object.
 * @returns an error message, or undefined when valid.
 */
export function validateAuth(auth) {
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return 'auth must be an object'
  if (auth.kind !== 'open' && auth.kind !== 'token') return 'auth.kind must be open or token'
  if (auth.kind === 'open') {
    // 青龙 calls the pair client_id/client_secret, 呆呆 app_key/app_secret:
    // both spellings are accepted and stored as appKey/appSecret.
    const key = auth.appKey ?? auth.clientId
    const secret = auth.appSecret ?? auth.clientSecret
    if (typeof key !== 'string' || key.trim() === '') return 'auth.appKey (client_id) is required'
    if (typeof secret !== 'string' || secret.trim() === '') return 'auth.appSecret (client_secret) is required'
  }
  if (auth.kind === 'token' && (typeof auth.token !== 'string' || auth.token.trim() === '')) {
    return 'auth.token is required'
  }
  return undefined
}

/**
 * Validate a panel payload (create: every required field; update: only the
 * fields present).
 * @param payload - raw payload.
 * @param opts - `partial` for PATCH semantics.
 * @returns an error message, or undefined when valid.
 */
export function validatePanelPayload(payload, opts = {}) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'body must be a JSON object'
  const partial = opts.partial === true
  if (!partial || payload.alias !== undefined) {
    const aliasError = validateAlias(payload.alias)
    if (aliasError !== undefined) return aliasError
  }
  if (!partial || payload.baseUrl !== undefined) {
    if (typeof payload.baseUrl !== 'string' || payload.baseUrl.trim() === '') return 'baseUrl is required'
    try {
      normalizeBaseUrl(payload.baseUrl)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  if (!partial || payload.auth !== undefined) {
    const authError = validateAuth(payload.auth)
    if (authError !== undefined) return authError
  }
  if (!partial || payload.kind !== undefined) {
    if (payload.kind !== undefined && !PANEL_KINDS.includes(payload.kind)) {
      return `kind must be one of ${PANEL_KINDS.join(', ')}`
    }
  }
  if (payload.timeoutMs !== undefined
    && (typeof payload.timeoutMs !== 'number' || !Number.isInteger(payload.timeoutMs)
      || payload.timeoutMs < MIN_TIMEOUT_MS || payload.timeoutMs > MAX_TIMEOUT_MS)) {
    return `timeoutMs must be an integer in ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`
  }
  if (payload.insecureTls !== undefined && typeof payload.insecureTls !== 'boolean') {
    return 'insecureTls must be a boolean'
  }
  if (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.some(tag => typeof tag !== 'string'))) {
    return 'tags must be an array of strings'
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return 'description must be a string'
  }
  return undefined
}

/** Normalize one auth block for storage: trim, drop irrelevant keys. */
function normalizeAuth(auth) {
  if (typeof auth !== 'object' || auth === null) return auth
  if (auth.kind === 'open') {
    const key = auth.appKey ?? auth.clientId
    const secret = auth.appSecret ?? auth.clientSecret
    return {
      kind: 'open',
      appKey: String(key).trim(),
      appSecret: String(secret).trim(),
    }
  }
  return { kind: 'token', token: String(auth.token).trim() }
}

/** Normalize a tag list. */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map(tag => tag.trim()).filter(tag => tag !== ''))]
}

/**
 * Fields a stored panel may carry. Anything else is dropped on load: a ghost
 * field written by an older build (an internal marker, a cached probe) must not
 * round-trip back into the file on the next save.
 */
const PANEL_FIELDS = [
  'alias', 'kind', 'baseUrl', 'auth', 'timeoutMs', 'insecureTls',
  'description', 'tags', 'test', 'createdAt', 'updatedAt',
]

/**
 * Bring one stored panel up to the current shape: only known fields survive, a
 * missing `kind` means a Qinglong panel (the store's original product), the
 * credential pair is normalized to `appKey`/`appSecret` whatever spelling it
 * was written with, and `tags` is always an array.
 */
function migratePanel(panel) {
  const out = {}
  for (const key of PANEL_FIELDS) {
    if (panel[key] !== undefined) out[key] = panel[key]
  }
  out.kind = PANEL_KINDS.includes(out.kind) ? out.kind : 'qinglong'
  out.auth = normalizeAuth(panel.auth)
  out.tags = normalizeTags(out.tags)
  return out
}

/**
 * The panel store. Pure file I/O — no cordis dependency, unit-testable.
 */
export class PanelStore {
  /**
   * @param path - store file path (defaults to the standard location).
   */
  constructor(path) {
    this.path = resolve(path ?? storePath())
    /** Last parsed file keyed by identity; any save invalidates. */
    this.cache = undefined
  }

  /** Load all entries (empty store when the file is absent). */
  list() {
    return this.load().panels
  }

  /** Find one entry by alias. */
  find(alias) {
    return this.list().find(entry => entry.alias === alias)
  }

  /** The default panel alias, falling back to the first configured panel. */
  defaultAlias() {
    const file = this.load()
    if (typeof file.defaultPanel === 'string' && file.panels.some(panel => panel.alias === file.defaultPanel)) {
      return file.defaultPanel
    }
    return file.panels.length > 0 ? file.panels[0].alias : undefined
  }

  /**
   * Secret-free projection for the browser and agent surfaces.
   * @param entry - stored entry.
   * @returns the public shape.
   */
  /**
   * Public projection of one stored panel.
   * @param entry - stored panel.
   * @param defaultAlias - the store's default alias, passed in by list callers
   *   so a projection of n panels costs one file read instead of n.
   */
  summarize(entry, defaultAlias = this.defaultAlias()) {
    return {
      alias: entry.alias,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      auth: entry.auth.kind,
      ...(entry.auth.kind === 'open' ? { appKey: entry.auth.appKey } : {}),
      hasSecret: true,
      // Optional keys are spread conditionally: an `undefined` property is not
      // a lossless JSON value, and tool outputs are validated against a schema.
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      insecureTls: entry.insecureTls === true,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      tags: [...entry.tags],
      // Last manual probe (reachability, version, credential state, scopes).
      // Persisted so the hosts table never has to re-query on every load.
      ...(entry.test !== undefined ? { test: entry.test } : {}),
      isDefault: entry.alias === defaultAlias,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  /**
   * Create one panel. Throws on a duplicate alias or an invalid payload.
   * @param payload - create payload.
   * @returns the stored entry.
   */
  create(payload) {
    const error = validatePanelPayload(payload, { partial: false })
    if (error !== undefined) throw new Error(error)
    const file = this.load()
    const alias = payload.alias.trim()
    if (file.panels.some(entry => entry.alias === alias)) throw new Error(`panel '${alias}' already exists`)
    const now = Date.now()
    const entry = {
      alias,
      kind: payload.kind ?? 'qinglong',
      baseUrl: normalizeBaseUrl(payload.baseUrl),
      auth: normalizeAuth(payload.auth),
      timeoutMs: payload.timeoutMs,
      insecureTls: payload.insecureTls === true,
      ...(typeof payload.description === 'string' && payload.description.trim() !== ''
        ? { description: payload.description.trim() }
        : {}),
      tags: normalizeTags(payload.tags),
      createdAt: now,
      updatedAt: now,
    }
    file.panels.push(entry)
    if (file.defaultPanel === undefined) file.defaultPanel = alias
    this.save(file)
    return entry
  }

  /**
   * Update the fields present in `patch` (PATCH semantics: a missing secret
   * keeps the stored one).
   * @param alias - panel alias from the URL.
   * @param patch - partial payload.
   * @returns the stored entry.
   */
  update(alias, patch) {
    const error = validatePanelPayload(patch, { partial: true })
    if (error !== undefined) throw new Error(error)
    const file = this.load()
    const entry = file.panels.find(candidate => candidate.alias === alias)
    if (entry === undefined) throw new Error(`panel '${alias}' not found`)
    if (patch.kind !== undefined) entry.kind = patch.kind
    if (patch.baseUrl !== undefined) entry.baseUrl = normalizeBaseUrl(patch.baseUrl)
    // A changed product, address or credential makes the stored probe stale.
    if (INVALIDATING_FIELDS.some(key => patch[key] !== undefined)) {
      delete entry.test
    }
    if (patch.auth !== undefined) entry.auth = normalizeAuth(patch.auth)
    if (patch.timeoutMs !== undefined) entry.timeoutMs = patch.timeoutMs
    if (patch.insecureTls !== undefined) entry.insecureTls = patch.insecureTls === true
    if (patch.description !== undefined) {
      const trimmed = patch.description.trim()
      if (trimmed === '') delete entry.description
      else entry.description = trimmed
    }
    if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags)
    entry.updatedAt = Date.now()
    this.save(file)
    return entry
  }

  /** Remove one panel; the default moves to the first remaining panel. */
  delete(alias) {
    const file = this.load()
    const index = file.panels.findIndex(candidate => candidate.alias === alias)
    if (index < 0) throw new Error(`panel '${alias}' not found`)
    file.panels.splice(index, 1)
    if (file.defaultPanel === alias) {
      file.defaultPanel = file.panels.length > 0 ? file.panels[0].alias : undefined
    }
    this.save(file)
  }

  /**
   * Persist the outcome of one manual probe.
   * @param alias - panel alias.
   * @param result - engine probe result (alias/kind/reachable/version/auth/message/scopes).
   * @returns the stored entry, or undefined when the panel disappeared meanwhile.
   */
  recordTest(alias, result) {
    if (typeof result !== 'object' || result === null) return undefined
    const file = this.load()
    const entry = file.panels.find(candidate => candidate.alias === alias)
    if (entry === undefined) return undefined
    const test = { at: Date.now() }
    for (const key of ['reachable', 'version', 'auth', 'message', 'scopes']) {
      if (result[key] !== undefined) test[key] = result[key]
    }
    entry.test = test
    entry.updatedAt = Date.now()
    this.save(file)
    return entry
  }

  /** Drop the persisted probe of one panel (credentials or address changed). */
  clearTest(alias) {
    const file = this.load()
    const entry = file.panels.find(candidate => candidate.alias === alias)
    if (entry === undefined || entry.test === undefined) return
    delete entry.test
    this.save(file)
  }

  /** Mark one panel as the default. */
  setDefault(alias) {
    const file = this.load()
    if (!file.panels.some(candidate => candidate.alias === alias)) throw new Error(`panel '${alias}' not found`)
    file.defaultPanel = alias
    this.save(file)
  }

  /** Load the store, caching by file identity. */
  load() {
    let stats
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, panels: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.panels)) {
        throw new Error('store file shape invalid')
      }
      const panels = parsed.panels
        .filter(panel => typeof panel === 'object' && panel !== null && typeof panel.alias === 'string')
        .map(migratePanel)
      const file = {
        version: FORMAT_VERSION,
        ...(typeof parsed.defaultPanel === 'string' ? { defaultPanel: parsed.defaultPanel } : {}),
        panels,
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file }
      return file
    } catch {
      // A corrupt store must not brick the plugin, and must not be silently
      // overwritten by the next save: rename it aside for manual recovery.
      this.cache = undefined
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        // best effort
      }
      return { version: FORMAT_VERSION, panels: [] }
    }
  }

  /** Write the store atomically at 0600 (secrets live here). */
  save(file) {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    const payload = {
      version: FORMAT_VERSION,
      ...(file.defaultPanel !== undefined ? { defaultPanel: file.defaultPanel } : {}),
      panels: file.panels,
    }
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = undefined
  }
}
