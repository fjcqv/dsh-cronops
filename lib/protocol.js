/**
 * Shared literals for the /api/dsh-cronops route family. The browser half
 * repeats them in client.js (the two halves are separate bundles with no
 * runtime identity to share), so these values are the single source of truth
 * for the host side and must stay in sync with the client constants.
 */

/** Route family base path. */
export const API_BASE = '/api/dsh-cronops'

/** Route paths the browser half calls. */
export const QL_API = {
  panels: API_BASE + '/panels',
  panelsDefault: API_BASE + '/panels/default',
  test: API_BASE + '/test',
  envs: API_BASE + '/envs',
  envsAction: API_BASE + '/envs/action',
  crons: API_BASE + '/crons',
  cronsItem: API_BASE + '/crons/item',
  cronsAction: API_BASE + '/crons/action',
  cronsLog: API_BASE + '/crons/log',
  cronsPreview: API_BASE + '/crons/preview',
  request: API_BASE + '/request',
}

/** Sidebar panel id, shared by the sidebar row and the main-slot key. */
export const PANEL_ID = 'cronops'

/** Qinglong OpenAPI prefix (relative to a panel base URL). */
export const OPEN_PREFIX = '/open'

/**
 * Open API path segments the generic request tool may not touch. `apps` needs
 * the apps scope and returns client secrets (and can reset them); `auth`,
 * `user` and `update` reach credentials, the owner account, or the panel
 * updater, none of which a browsing agent should drive.
 */
export const DENIED_PATH_SEGMENTS = ['apps', 'auth', 'user', 'update']

/** Daidai Panel: segments an application's scopes may cover. */
export const DAIDAI_ALLOWED_PATH_SEGMENTS = [
  'tasks',
  'envs',
  'logs',
  'scripts',
  'subscriptions',
  'system',
]

/** Daidai Panel: segments that reach credentials, accounts or backups. */
export const DAIDAI_DENIED_PATH_SEGMENTS = ['open-api', 'users', 'auth', 'mcp']

/** Path segments the generic request tool may touch (an application's scopes). */
export const ALLOWED_PATH_SEGMENTS = [
  'crons',
  'envs',
  'subscriptions',
  'configs',
  'scripts',
  'logs',
  'dependencies',
  'system',
  'dashboard',
  'health',
]
