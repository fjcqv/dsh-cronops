/**
 * Shared literals for the /api/dsh-cronops route family. The browser half
 * repeats them in client.js (the two halves are separate bundles with no
 * runtime identity to share), so these values are the single source of truth
 * for the host side and must stay in sync with the client constants.
 */

/** Route family base path. */
import { KIND_META } from './panels/kinds.js'

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
 * Which segments the generic bridge may reach for one product. The list is
 * declared in `panels/kinds.js` next to the rest of the product catalogue,
 * because the resource names differ per product and hard-coding two of them
 * silently locked the third one out.
 * @param kind - panel product behind the alias.
 * @returns the `{allowed, denied}` pair for that product.
 */
export function proxyPolicy(kind) {
  const meta = KIND_META.find(entry => entry.kind === kind)
  if (meta?.proxy !== undefined) return meta.proxy
  return { allowed: ALLOWED_PATH_SEGMENTS, denied: DENIED_PATH_SEGMENTS }
}

/**
 * Open API path segments the generic request tool may not touch. `apps` needs
 * the apps scope and returns client secrets (and can reset them); `auth`,
 * `user` and `update` reach credentials, the owner account, or the panel
 * updater, none of which a browsing agent should drive.
 */
export const DENIED_PATH_SEGMENTS = ['apps', 'auth', 'user', 'update']

/** Path segments the generic request tool may touch (an application's scopes). */
/**
 * POST routes that only read. The generic bridge refuses writes to resources
 * that have a dedicated tool, and it judged that by the first path segment
 * alone — so 呆呆's expression parser (`POST /tasks/cron/parse`) was answered
 * with "写 /tasks 请用 cronops_crons", advice that has nothing to do with
 * previewing a schedule.
 */
export const READ_ONLY_POSTS = {
  qinglong: ['/crons/preview'],
  daidai: ['/tasks/cron/parse', '/tasks/preview'],
}

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
  // `health` is deliberately absent: `/open/health` needs a panel-side health
  // scope that an application credential cannot be granted, so listing it only
  // produced a misleading "暂无权限".
]
