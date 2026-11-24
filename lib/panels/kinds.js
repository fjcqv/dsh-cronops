/**
 * Panel product catalogue: the one place that knows which products exist and
 * what each one looks like from the outside.
 *
 * This module is pure data with no imports, so the store (which validates the
 * `kind` field), the drivers, the routes and the agent tools can all read it
 * without a dependency cycle. Adding a product means appending one entry here
 * plus one adapter in `./index.js`.
 */

/** Panel product identifiers a store entry may carry. */
export const PANEL_KINDS = ['qinglong', 'daidai']

/**
 * Per-product metadata.
 *
 * - `label` — short badge text in the UI.
 * - `errorLabel` — full product name used in error copy ("无法连接青龙面板").
 * - `credentialFields` — order and copy of the credential form; `key` is the
 *   stored auth field name (the store normalizes both key-pair products to
 *   `appKey`/`appSecret`), `i18nKey` the label词条, `secret` a password input.
 * - `authKind` — the credential shape the product needs: `'open'` for a
 *   key/secret pair exchanged for a token, `'token'` for a token minted in the
 *   panel and pasted in.
 * - `scopeOrder` — order of the scope badges on the hosts tab.
 * - `ignoredScopes` — scopes the driver may report but the UI must not show.
 * - `supportsWorkDir` — whether a task carries a working directory.
 * - `proxy` — which path segments the generic request bridge may reach. The
 *   resource names differ per product (青龙 `crons`, 呆呆 `tasks`), so the
 *   list belongs here rather than in the bridge.
 */
export const KIND_META = [
  {
    kind: 'qinglong',
    label: '青龙',
    errorLabel: '青龙面板',
    authKind: 'open',
    credentialFields: [
      { key: 'appKey', i18nKey: 'panels.field.clientId', secret: false },
      { key: 'appSecret', i18nKey: 'panels.field.clientSecret', secret: true },
    ],
    scopeOrder: ['envs', 'crons', 'subscriptions', 'configs', 'scripts', 'logs', 'dependencies', 'system', 'dashboard'],
    ignoredScopes: [],
    supportsWorkDir: true,
    proxy: {
      allowed: ['crons', 'envs', 'subscriptions', 'configs', 'scripts', 'logs', 'dependencies', 'system', 'dashboard'],
      denied: ['apps', 'auth', 'user', 'update'],
    },
  },
  {
    kind: 'daidai',
    label: '呆呆',
    errorLabel: '呆呆面板',
    authKind: 'open',
    credentialFields: [
      { key: 'appKey', i18nKey: 'panels.field.appKey', secret: false },
      { key: 'appSecret', i18nKey: 'panels.field.appSecret', secret: true },
    ],
    scopeOrder: ['tasks', 'envs', 'logs', 'scripts', 'subscriptions', 'system', 'backup'],
    // `notifications` needs a panel user token, so probing it with an
    // application credential always answers 403 and says nothing about scope.
    ignoredScopes: ['notifications'],
    supportsWorkDir: false,
    proxy: {
      allowed: ['tasks', 'envs', 'logs', 'scripts', 'subscriptions', 'system'],
      denied: ['open-api', 'users', 'auth', 'mcp'],
    },
  },
]

/** Metadata of one product, or undefined when it is not registered. */
export function kindMeta(kind) {
  return KIND_META.find(meta => meta.kind === kind)
}

/** Full product name for error copy (falls back to the generic word). */
export function errorLabelOf(kind) {
  return kindMeta(kind)?.errorLabel ?? '面板'
}
