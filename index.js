/**
 * dsh-cronops — host half.
 *
 * Mounts the panel store ($DSH_HOME/dsh-cronops.json), the panel drivers
 * (青龙 / 呆呆), the /api/dsh-cronops route family, the agent tools
 * (cronops_panels / cronops_envs / cronops_crons / cronops_api), and an
 * optional system-prompt announcement. The browser half (./client) renders the
 * sidebar entry, the hosts tab, the environment-variable tab and the
 * scheduled-task tab.
 *
 * The host half imports nothing outside `node:` builtins: a bundle linked from
 * a workspace directory cannot resolve the profile's node_modules, so plugin
 * config is read from the row's own `config` object and the tools are written
 * as plain ToolDefinition objects.
 */

import { DEFAULT_TIMEOUT_MS } from './lib/qinglong.js'
import { PanelEngine } from './lib/engine.js'
import { makeRoutes } from './lib/routes.js'
import { PanelStore } from './lib/store.js'
import { buildTools } from './lib/tools.js'

/** Stable cordis plugin name. */
export const name = 'cronops'

/** Services required before the panel surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Defaults for the row's optional config keys. */
const DEFAULTS = {
  enabled: true,
  announceToAgent: false,
  requestTimeoutMs: DEFAULT_TIMEOUT_MS,
  allowProxiedRequests: false,
}

/** Order of this plugin's prompt section (the SSH plugin uses 150). */
const SECTION_ORDER = 160

/** The four agent-tool names this plugin registers. */
const TOOL_NAMES = ['cronops_panels', 'cronops_envs', 'cronops_crons', 'cronops_api']

/**
 * Read one config key, tolerating the live reference a `volatile()` schema
 * field would produce if this row is ever given one by a bundle layer.
 * @param config - resolved config object.
 * @param key - key name.
 * @param fallback - value when absent or undefined.
 */
function readConfig(config, key, fallback) {
  const field = config?.[key]
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/**
 * The loader's own record of the profile entry this instance was activated
 * from (absent on a host without the loader).
 */
function profileConfig(ctx) {
  const entry = ctx.fiber?.entry
  const config = entry?.options?.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  return config
}

/** Model-facing announcement: what this plugin is, what it can do, its limits. */
export const CRONOPS_GUIDANCE = '本机已安装 dsh-cronops 插件（DSH 定时面板控制台，支持青龙面板与呆呆面板）：侧边栏「定时面板」入口，页面只有三个页签——主机（面板连接，可选青龙/呆呆）、环境变量、定时任务。能力：面板连接存 $DSH_HOME/dsh-cronops.json（默认 ~/.dsh，0600）。青龙走 /open/* OpenAPI，应用凭据 client_id + client_secret（或直接粘 token），令牌 30 天自动续期；呆呆走 /api/v1/* OpenAPI，应用凭据 app_key + app_secret（或粘 token），令牌 24 小时自动续期。工具：cronops_panels（列出/探活面板）、cronops_envs（列/建/改/删/启停环境变量）、cronops_crons（列/详情/建/改/运行/停止/启停/删除/日志/预览定时规则）、cronops_api（通用桥：青龙的 subscriptions/configs/scripts/logs/dependencies/system/dashboard，呆呆的 logs/scripts/subscriptions/system）。限制：青龙的 /open/apps、/open/auth、/open/user、/open/update 与呆呆的 open-api、users、auth、mcp 一律拒绝（涉及凭据、账号与备份）；运行任务成功仅代表面板已受理触发，不代表脚本执行完成；写操作真实改动面板。用户提到「青龙 / 呆呆 / 定时任务 / 环境变量 / 面板」时即指本插件。'

/** Process-wide mount guard (a bundle row and a standalone install may coexist). */
const MOUNTED_KEY = Symbol.for('dsh-web.mounted-plugins')

/**
 * Claim this package name once per process.
 * @returns false when another mount already owns it.
 */
function claimMount(ctx) {
  const registry = globalThis
  const set = registry[MOUNTED_KEY] instanceof Set ? registry[MOUNTED_KEY] : (registry[MOUNTED_KEY] = new Set())
  if (set.has('dsh-cronops')) return false
  set.add('dsh-cronops')
  ctx.effect?.(() => () => { set.delete('dsh-cronops') })
  return true
}

/**
 * Mount the panel surfaces.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - the row's config object (all keys optional).
 */
export function apply(ctx, config) {
  if (!claimMount(ctx)) return
  const store = new PanelStore()
  const timeoutOf = () => readConfig(config, 'requestTimeoutMs', DEFAULTS.requestTimeoutMs)
  const engine = new PanelEngine(store, { timeoutMs: timeoutOf() })
  ctx.effect(() => () => { engine.dispose() }, 'dsh-cronops: engine')

  const routes = makeRoutes({
    store,
    engine,
    allowProxiedRequests: () => readConfig(config, 'allowProxiedRequests', DEFAULTS.allowProxiedRequests) === true,
  })
  const tools = buildTools(engine, store)

  let disposeRoutes
  let disposeTools
  let disposeSection

  const sync = () => {
    engine.setRequestTimeout(timeoutOf())
    const enabled = readConfig(config, 'enabled', DEFAULTS.enabled) === true
      // A profile that seeded `enabled: false` while the user already has
      // panels configured must not lose them on upgrade.
      || (profileConfig(ctx)?.enabled === undefined && store.list().length > 0)
    const announce = readConfig(config, 'announceToAgent', DEFAULTS.announceToAgent) === true

    for (const dispose of [disposeSection, disposeRoutes, disposeTools]) {
      if (dispose !== undefined) dispose()
    }
    disposeSection = undefined
    disposeRoutes = undefined
    disposeTools = undefined
    if (enabled !== true) return

    if (announce) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-cronops',
        order: SECTION_ORDER,
        text: visibleToolText(ctx.tools, TOOL_NAMES, CRONOPS_GUIDANCE),
      })
    }
    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-cronops: routes')
    disposeTools = ctx.effect(() => {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-cronops: tools')
  }

  ctx.on('loader/volatile-update', () => { sync() })
  sync()
}

/**
 * Render guidance only while at least one described tool is reachable: a
 * restriction that removes the tool surface must take the guidance with it.
 * @param tools - the tool registry, when the deployment serves one.
 * @param names - tool names the guidance describes.
 * @param guidance - guidance rendered while they are reachable.
 */
function visibleToolText(tools, names, guidance) {
  if (tools === undefined || typeof tools.get !== 'function') return () => guidance
  return (context) => {
    for (const toolName of names) {
      try {
        if (tools.get(toolName, context?.scope) !== undefined) return guidance
      } catch {
        return guidance
      }
    }
    return ''
  }
}
