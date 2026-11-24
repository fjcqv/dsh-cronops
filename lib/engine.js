/**
 * Panel engine facade.
 *
 * The routes and the agent tools talk to ONE object with one method surface,
 * whichever product is behind it. `store` entries carry a `kind`, and this
 * facade delegates each call to the matching driver built by the registry in
 * `lib/panels/`: a driver owns transport, credentials and one product's
 * resource semantics, and keeps its token/scope caches keyed by panel alias, so
 * a credential change (`dropAlias`) or a plugin unload clears both.
 */

import { PanelError } from './panels/driver.js'
import { descriptors, driverFor, registeredKinds } from './panels/index.js'

/**
 * Operations delegated one-to-one to the driver of the addressed alias. Each
 * one takes the alias as its first argument; the rest is the driver's problem.
 */
const OPERATIONS = [
  'envsList', 'envsCreate', 'envsUpdate', 'envsRemove', 'envsToggle',
  'cronsList', 'cronsGet', 'cronsCreate', 'cronsUpdate', 'cronsRemove',
  'cronsAction', 'cronsLog', 'cronsLogFiles', 'cronsPreview',
  'scriptsList', 'scriptsRead', 'scriptsWrite', 'scriptsRun',
  'raw',
]

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
    /** product id -> driver */
    this.drivers = new Map(registeredKinds().map(kind => [kind, driverFor(kind, store, options)]))
  }

  /** Resolve the panel an operation addresses (default panel when omitted). */
  entry(alias) {
    if (typeof alias === 'string' && alias !== '') {
      const found = this.store.find(alias)
      if (found === undefined) throw new PanelError(`panel '${alias}' 不存在`, { code: 404, status: 404, kindLabel: '面板' })
      return found
    }
    const fallback = this.store.defaultAlias()
    const found = fallback === undefined ? undefined : this.store.find(fallback)
    if (found === undefined) throw new PanelError('尚未配置面板，请先在「主机」页签新增一个。', { code: 404, status: 404, kindLabel: '面板' })
    return found
  }

  /** The driver that serves this alias. */
  driver(alias) {
    const kind = this.entry(alias).kind
    const driver = this.drivers.get(kind)
    if (driver === undefined) {
      throw new PanelError(`未知面板类型 '${kind}'`, { code: 404, status: 404, kindLabel: '面板' })
    }
    return driver
  }

  /** Which product backs this alias. */
  kindOf(alias) {
    return this.entry(alias).kind
  }

  /** The available products, for UI/config validation. */
  kinds() {
    return registeredKinds()
  }

  /** Product descriptors the browser half renders its form from. */
  descriptors() {
    return descriptors()
  }

  // ------------------------------------------------------------ lifecycle

  setRequestTimeout(ms) {
    for (const driver of this.drivers.values()) driver.setRequestTimeout(ms)
  }

  dropAlias(alias) {
    for (const driver of this.drivers.values()) driver.dropAlias(alias)
  }

  dispose() {
    for (const driver of this.drivers.values()) driver.dispose()
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
}

for (const name of OPERATIONS) {
  PanelEngine.prototype[name] = function delegate(...args) {
    return this.driver(args[0])[name](...args)
  }
}
