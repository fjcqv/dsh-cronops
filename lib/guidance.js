/**
 * Everything the model is told about this plugin, in one place.
 *
 * The panel products spell the same resource differently (`/envs` vs `/envs/<id>`
 * vs `/envs/batch`), and a model that guesses a path gets a bare `Validation
 * failed`. So the path knowledge lives here ONCE and is rendered twice: into the
 * system prompt (so it is known before the first call) and into the failure hint
 * of the generic bridge (so a wrong guess self-corrects). Neither surface keeps
 * its own copy.
 */

import { PanelError } from './panels/driver.js'

/** What the plugin is, what it can do, and what it refuses. */
export const PANEL_GUIDANCE = '本机已安装 dsh-cronops 插件（DSH 定时面板控制台，支持青龙面板与呆呆面板）：侧边栏「定时面板」入口，页面只有三个页签——主机（面板连接，可选青龙/呆呆）、环境变量、定时任务。能力：面板连接存 $DSH_HOME/dsh-cronops.json（默认 ~/.dsh，0600）。青龙走 /open/* OpenAPI，应用凭据 client_id + client_secret（或直接粘 token），令牌 30 天自动续期；呆呆走 /api/v1/* OpenAPI，应用凭据 app_key + app_secret（或粘 token），令牌 24 小时自动续期。工具：cronops_panels（列出/探活面板）、cronops_envs（列/建/改/删/启停环境变量）、cronops_crons（列/详情/建/改/运行/停止/启停/删除/日志/预览定时规则）、cronops_script（脚本读写：list 列目录、read 读正文、write 把本地文件推上面板并回读校验 sha256、run 触发执行——要推本地脚本一律用它，不要手拼 PUT /scripts 或用 curl）、cronops_api（通用桥：青龙的 subscriptions/configs/logs/dependencies/system/dashboard，呆呆的 logs/scripts/subscriptions/system）。通用桥只做逃生口：对 envs/crons/tasks/scripts 的写一律拒绝并指向专用工具（专用工具会先读后合并、分块、回读校验），路径写错时会回带正确用法。易错点：青龙 /logs/detail 必填 path+file、/health 应用凭据不可用；呆呆系统信息是 /system/info、仪表盘是 /system/dashboard、备份是 /system/backups。限制：青龙的 /open/apps、/open/auth、/open/user、/open/update 与呆呆的 open-api、users、auth、mcp 一律拒绝（涉及凭据、账号与备份）；运行任务成功仅代表面板已受理触发，不代表脚本执行完成；写操作真实改动面板。面板「client_id/app_key」不是令牌，拿它当 Bearer 必然 401，令牌由插件自动换取。用户提到「青龙 / 呆呆 / 定时任务 / 环境变量 / 脚本 / 面板」时即指本插件。'

const RESOURCE_HINTS = {
  'qinglong:/envs': 'GET /envs?searchValue=；GET /envs/<id>（id 在路径里，没有 /envs/detail）；POST /envs（对象数组，name/value 必填）；PUT /envs {id,name,value}；DELETE /envs、PUT /envs/enable|disable 的 body 直接是 id 数字数组如 [65]，不是 {ids:[...]}',
  'qinglong:/crons': 'GET /crons?searchValue=&page=&size=；GET /crons/<id>；GET /crons/<id>/log；POST /crons {name,command,schedule}；PUT /crons {id,command,schedule}；PUT /crons/run|stop|enable|disable 的 body 直接是 id 数字数组如 [65]；DELETE /crons {ids,labels}',
  'qinglong:/scripts': 'GET /scripts?path=；GET /scripts/detail?path=&file=（file 必填）；POST /scripts 新建、PUT /scripts 只改已存在的文件（新建用 PUT 会 404 脚本不存在），body {filename,path,content}；DELETE /scripts {filename,path}；PUT /scripts/run {filename,path}',
  'qinglong:/logs': 'GET /logs（目录树）；GET /logs/detail?path=&file=',
  'daidai:/envs': 'GET /envs?page=&page_size=；GET /envs/<id>；PUT /envs/<id>（部分字段）；DELETE /envs/batch {ids}；PUT /envs/batch/enable|disable {ids}',
  'daidai:/tasks': 'GET /tasks?page=&page_size=（单任务没有独立 GET）；PUT /tasks/<id>；POST /tasks/batch/run {task_ids}（≤10）',
  'daidai:/scripts': 'GET /scripts；GET /scripts/tree；GET /scripts/content?path=<文件>；PUT /scripts/content {path,content}；POST /scripts/run',
}

/** Cheatsheet for the resource a path belongs to, or undefined. */
export function resourceHint(kind, path) {
  const segment = '/' + (path.split('/').filter(Boolean)[0] ?? '')
  return RESOURCE_HINTS[`${kind}:${segment}`]
}

/**
 * The resource cheatsheets joined into one paragraph.
 * @returns every hint, keyed by product and resource.
 */
export function renderResourceHints() {
  return Object.entries(RESOURCE_HINTS).map(([key, text]) => key + '：' + text).join('；')
}

/**
 * The full system-prompt section: the product story plus the path cheatsheets,
 * so a path is never guessed blind.
 * @returns the section text.
 */
export function renderGuidance() {
  return PANEL_GUIDANCE + '\n\n各面板路径速查（调用通用桥前先对一遍，写错会返回同一份提示）：' + renderResourceHints()
}

/** Path-specific corrections for a rejected call, keyed `${kind}:${path}`. */
const REQUIRED_HINTS = {
  'qinglong:/scripts/detail': '需要 query：path（目录，可为空）+ file（文件名）',
  'qinglong:/logs/detail': '需要 query：path + file',
  'qinglong:/scripts': 'PUT 保存需要 body：{filename, path, content}',
  'qinglong:/envs': 'PUT 更新需要 body：{id, name, value}；按 id 取单条用 GET /envs/<id>',
  'qinglong:/crons': 'PUT 更新需要 body：{id, command, schedule}',
  'daidai:/scripts/content': 'GET 需要 query path；PUT 需要 body {path, content}',
}

/** The replacement route behind a 410, per product. */
const GONE_HINTS = {
  qinglong: '；读取脚本请用 GET /scripts/detail?path=<目录，可为空>&file=<文件名>',
  daidai: '；读取脚本请用 GET /scripts/content?path=<文件相对路径>',
}

/** The paths each product actually serves, for a 404. */
const COMMON_PATHS = {
  qinglong: '常用：/envs /crons /logs/detail（需 path+file）/subscriptions /scripts /system /dashboard/overview',
  daidai: '常用：/tasks /envs /logs /scripts /subscriptions /system/info /system/dashboard /system/backups',
}

/** Hints already appended to one error object, so each is added once. */
const APPENDED_HINTS = Symbol('dsh-cronops.appendedHints')

/**
 * Append an actionable hint to a bridge failure: what the path really wants,
 * where a retired route moved, which paths exist. The agent reads one message
 * and can retry without another round trip.
 * @param error - the failure thrown by the bridge.
 * @param kind - panel product id.
 * @param path - the resource path that failed.
 * @returns the same error, with its message extended in place.
 */
export function withPathHint(error, kind, path) {
  if (!(error instanceof PanelError)) return error
  // Qinglong answers business failures with HTTP 200 + a `code`, so the code is
  // the reliable status here (Daidai sends real HTTP statuses and no code).
  const status = error.code ?? error.status
  const base = error.message
  const seen = error[APPENDED_HINTS] ?? (error[APPENDED_HINTS] = new Set())
  const add = (key, text) => {
    if (seen.has(key)) return
    seen.add(key)
    error.message += text
  }

  // A retired route still answers with a code + a replacement hint from the
  // panel; restate the exact call, including the fields it requires.
  if (status === 410 && !base.includes('path=')) add('gone', GONE_HINTS[kind])

  // "Validation failed" alone does not name the missing fields.
  if (status === 400 && /validation failed|参数|required/i.test(base)) {
    const hint = REQUIRED_HINTS[`${kind}:${path}`]
    if (hint !== undefined) add('required', '；' + hint)
    else add('required-generic', '；面板只说参数不合法，没指出是哪个字段——按下面的用法核对')
  }

  // A wrong sub-path surfaces as validation or 404 noise; name the real shapes.
  const cheatsheet = resourceHint(kind, path)
  if (cheatsheet !== undefined && (status === 400 || status === 404 || status === 410)) {
    add('cheatsheet', '\n该资源的用法：' + cheatsheet)
  }

  if (status === 404 && !base.includes('常用')) {
    add('not-found', `；路径不存在：${path}。${COMMON_PATHS[kind]}`)
  } else if (status === 403 && !base.includes('scope')) {
    add('scope', '；该资源不在应用凭据可用的 scope 内（青龙 /health 这类端点应用凭据永远拿不到）')
  }
  return error
}
