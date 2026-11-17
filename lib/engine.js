/**
 * Panel engine facade.
 *
 * The routes and the agent tools talk to ONE object with one method surface,
 * whichever panel product is behind it. `store` entries carry a `kind`, and
 * this facade delegates each call to the matching driver:
 *
 * - `qinglong` → lib/qinglong.js (青龙面板, `/open` OpenAPI, client_id/secret)
 * - `daidai`   → lib/daidai.js   (呆呆面板, `/api/v1` OpenAPI, app_key/secret)
 *
 * Token/scope caches stay inside each driver, keyed by panel alias, so a
 * credential change (`dropAlias`) or a plugin unload clears both.
 */

import { DaidaiEngine } from './daidai.js'
import { QinglongEngine, QinglongError } from './qinglong.js'

/** Panel product identifiers a store entry may carry. */
export const PANEL_KINDS = ['qinglong', 'daidai']

/**
 * The engine the plugin's surfaces use.
 */
export class PanelEngine {
  /**
   * @param store - the panel store.
   * @param options - request timeout.
   */
  constructor(store, options = {}) {
    this.store = store
    this.engines = {
      qinglong: new QinglongEngine(store, options),
      daidai: new DaidaiEngine(store, options),
    }
  }

  /** Resolve the panel an operation addresses (default panel when omitted). */
  entry(alias) {
    if (typeof alias === 'string' && alias !== '') {
      const found = this.store.find(alias)
      if (found === undefined) {
        throw new QinglongError(`panel '${alias}' 不存在`, { code: 404, status: 404 })
      }
      return found
    }
    const fallback = this.store.defaultAlias()
    const found = fallback === undefined ? undefined : this.store.find(fallback)
    if (found === undefined) {
      throw new QinglongError('尚未配置面板，请先在「主机」页签新增一个。', { code: 404, status: 404 })
    }
    return found
  }

  /** The driver that serves this alias. */
  driver(alias) {
    const kind = this.entry(alias).kind
    return this.engines[kind] ?? this.engines.qinglong
  }

  /** Which product backs this alias (`qinglong` / `daidai`). */
  kindOf(alias) {
    return this.entry(alias).kind
  }

  /** The available products, for UI/config validation. */
  kinds() {
    return [...PANEL_KINDS]
  }

  // ------------------------------------------------------------ delegation

  setRequestTimeout(ms) {
    for (const engine of Object.values(this.engines)) engine.setRequestTimeout(ms)
  }

  dropAlias(alias) {
    for (const engine of Object.values(this.engines)) engine.dropAlias(alias)
  }

  dispose() {
    for (const engine of Object.values(this.engines)) engine.dispose()
  }

  /**
   * Probe one panel and persist the outcome so the hosts table can render it
   * without querying again on every load.
   */
  async test(alias, options) {
    const entry = this.entry(alias)
    const result = await this.driver(alias).test(alias, options)
    try {
      this.store.recordTest(result?.alias ?? entry.alias, result)
    } catch {
      // A persistence failure must not hide the probe result.
    }
    return result
  }

  envsList(alias, searchValue) {
    return this.driver(alias).envsList(alias, searchValue)
  }

  envsCreate(alias, envs) {
    return this.driver(alias).envsCreate(alias, envs)
  }

  envsUpdate(alias, id, patch) {
    return this.driver(alias).envsUpdate(alias, id, patch)
  }

  envsRemove(alias, ids) {
    return this.driver(alias).envsRemove(alias, ids)
  }

  envsToggle(alias, action, ids) {
    return this.driver(alias).envsToggle(alias, action, ids)
  }

  cronsList(alias, query) {
    return this.driver(alias).cronsList(alias, query)
  }

  cronsGet(alias, id) {
    return this.driver(alias).cronsGet(alias, id)
  }

  cronsCreate(alias, cron) {
    return this.driver(alias).cronsCreate(alias, cron)
  }

  cronsUpdate(alias, id, patch) {
    return this.driver(alias).cronsUpdate(alias, id, patch)
  }

  cronsRemove(alias, ids) {
    return this.driver(alias).cronsRemove(alias, ids)
  }

  cronsAction(alias, action, ids) {
    return this.driver(alias).cronsAction(alias, action, ids)
  }

  cronsLog(alias, id, query) {
    return this.driver(alias).cronsLog(alias, id, query)
  }

  cronsLogFiles(alias, id) {
    return this.driver(alias).cronsLogFiles(alias, id)
  }

  cronsPreview(alias, schedule) {
    return this.driver(alias).cronsPreview(alias, schedule)
  }

  raw(alias, options) {
    return this.driver(alias).raw(alias, options)
  }
}
