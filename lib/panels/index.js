/**
 * Panel registry.
 *
 * One table from product id to adapter. Adding a product is one entry in
 * `./kinds.js` (its metadata) plus one adapter file plus one `registerAdapter`
 * call here — the engine, the routes, the agent tools and the browser half read
 * their behaviour from this table and need no edit.
 *
 * `registerAdapter` is public so a test can mount a third product from a single
 * fixture file and prove exactly that (see `scripts/fixtures/panel3.js`).
 */

import { DaidaiDriver } from './daidai.js'
import { PanelError } from './driver.js'
import { KIND_META } from './kinds.js'
import { QinglongDriver } from './qinglong.js'

/** product id -> adapter class */
const ADAPTERS = new Map()
/** product id -> public descriptor */
const DESCRIPTORS = new Map()

/**
 * Mount one product.
 * @param kind - product id (unique).
 * @param Adapter - PanelDriver subclass.
 * @param meta - its `KIND_META` entry.
 */
export function registerAdapter(kind, Adapter, meta) {
  ADAPTERS.set(kind, Adapter)
  DESCRIPTORS.set(kind, {
    kind,
    label: meta.label,
    authKind: meta.authKind ?? 'open',
    credentialFields: meta.credentialFields.map(field => ({ ...field })),
    scopeOrder: [...meta.scopeOrder],
    ignoredScopes: [...(meta.ignoredScopes ?? [])],
    supportsWorkDir: meta.supportsWorkDir === true,
  })
}

/** Unmount one product (tests only). */
export function unregisterAdapter(kind) {
  ADAPTERS.delete(kind)
  DESCRIPTORS.delete(kind)
}

/** The mounted product ids, in registration order. */
export function registeredKinds() {
  return [...ADAPTERS.keys()]
}

/**
 * Build the driver for one product.
 * @param kind - product id from a store entry.
 * @param store - the panel store.
 * @param options - request timeout.
 * @returns the adapter instance.
 * @throws PanelError for an unregistered product (never a silent fallback).
 */
export function driverFor(kind, store, options = {}) {
  const Adapter = ADAPTERS.get(kind)
  if (Adapter === undefined) {
    throw new PanelError(`未知面板类型 '${kind}'`, { code: 404, status: 404, kindLabel: '面板' })
  }
  return new Adapter(store, options)
}

/**
 * The public projection of every mounted product, served to the browser half so
 * it can render the panel form without hardcoding product names.
 * @returns one descriptor per product.
 */
export function descriptors() {
  return [...DESCRIPTORS.values()].map(descriptor => ({ ...descriptor }))
}

// The products that ship with the plugin. Everything else registers itself.
const SHIPPED = { qinglong: QinglongDriver, daidai: DaidaiDriver }
for (const meta of KIND_META) {
  const Adapter = SHIPPED[meta.kind]
  if (Adapter !== undefined) registerAdapter(meta.kind, Adapter, meta)
}
