/**
 * Agent tools for the Qinglong panel.
 *
 * Definitions are written as plain ToolDefinition objects — no SDK package is
 * imported, so the bundle stays resolvable from any directory (a linked
 * workspace package cannot reach the profile's node_modules). Each tool calls
 * the same engine the browser half's routes call, so a panel managed in the
 * GUI is immediately operable by an agent and vice versa.
 *
 * The UI covers hosts, environment variables and scheduled tasks;
 * `cronops_api` opens the remaining OpenAPI resources (subscriptions,
 * configs, scripts, logs, dependencies, system, dashboard) with the same
 * refusal list the HTTP bridge applies.
 */

import {
  ALLOWED_PATH_SEGMENTS,
  DAIDAI_ALLOWED_PATH_SEGMENTS,
  DAIDAI_DENIED_PATH_SEGMENTS,
  DENIED_PATH_SEGMENTS,
} from './protocol.js'
import { QinglongError } from './qinglong.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** One text content block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Render a JSON value compactly for a tool result. */
function show(value) {
  if (value === undefined) return '(no data)'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Render the panel table. */
function renderPanels(panels) {
  if (!Array.isArray(panels) || panels.length === 0) return '尚未配置面板'
  const rows = panels.map(panel => [
    panel.alias,
    panel.kind ?? 'qinglong',
    panel.baseUrl,
    panel.auth,
    panel.appKey ?? '-',
    panel.isDefault ? 'default' : '-',
  ].join(' | '))
  return [
    'alias | kind | baseUrl | auth | client_id/app_key | default',
    '--- | --- | --- | --- | --- | ---',
    ...rows,
    '',
    '注意：client_id/app_key 不是令牌（拿它当 Bearer 一定 401）；令牌由插件用凭据自动换取，脚本读写直接用 cronops_script。',
  ].join('\n')
}

/** Render the env table. */
function renderEnvs(envs) {
  if (!Array.isArray(envs) || envs.length === 0) return '没有环境变量'
  const rows = envs.map(env => [
    String(env.id ?? '-'),
    String(env.name ?? '-'),
    String(env.value ?? '').slice(0, 80),
    String(env.remarks ?? ''),
    env.isDisabled === true || env.status === 1 || env.status === '1' ? 'yes' : 'no',
  ].join(' | '))
  return ['id | name | value | remarks | disabled', '--- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render the task table. */
function renderCrons(rows, total) {
  if (!Array.isArray(rows) || rows.length === 0) return '没有定时任务'
  const header = `共 ${total ?? rows.length} 个任务`
  const lines = rows.map(row => [
    String(row.id ?? '-'),
    String(row.name ?? ''),
    String(row.schedule ?? ''),
    String(row.status ?? ''),
    String(row.command ?? '').slice(0, 80),
  ].join(' | '))
  return [header, 'id | name | schedule | status | command', '--- | --- | --- | --- | ---', ...lines].join('\n')
}

/** Normalize the ids argument (a single id is accepted too). */
function ids(args) {
  const raw = args.ids ?? args.id
  const list = Array.isArray(raw) ? raw : [raw]
  const clean = list.map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0)
  if (clean.length === 0) throw new QinglongError('需要至少一个任务/变量 ID')
  return clean
}

/** Panel listing and connection probing. */
export function cronopsPanelsTool(engine, store) {
  return {
    name: 'cronops_panels',
    description: 'List configured task panels (青龙 / 呆呆; alias, kind, base URL, credential kind, default) or probe one panel: reachability, panel version, credential state and per-resource scopes. Secrets are never returned.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'test'], description: 'list configured panels, or test one panel.' },
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          panels: { type: 'array', items: {} },
          result: {},
        },
      },
      render: (_args, value) => {
        if (value?.result !== undefined) {
          const result = value.result
          const scopes = result?.scopes
          const lines = [show(result)]
          if (typeof scopes === 'object' && scopes !== null) {
            lines.push('', '权限（只读探测）: ' + Object.entries(scopes).map(([name, state]) => `${name}=${state}`).join(' '))
          }
          return text(lines.join('\n'))
        }
        return text(renderPanels(value?.panels ?? []))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.action === 'list') {
        return { panels: store.list().map(entry => store.summarize(entry)) }
      }
      return { result: await engine.test(args.alias, { refresh: true }) }
    },
  }
}

/** Environment-variable management. */
export function cronopsEnvsTool(engine) {
  return {
    name: 'cronops_envs',
    description: 'Manage one panel\'s environment variables: list (search), create, update, delete, enable, disable. Writes change the real panel. Variable names must start with a letter or underscore.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete', 'enable', 'disable'],
          description: 'Operation to perform.',
        },
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
        searchValue: { type: 'string', description: 'list: fuzzy match on name/value.' },
        envs: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'create: array of { name, value, remarks?, labels? }.',
        },
        env: {
          type: 'object',
          additionalProperties: true,
          description: 'update: { id, name?, value?, remarks?, labels? } — the stored row is merged before the panel call.',
        },
        ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'delete/enable/disable: environment variable ids.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          envs: { type: 'array', items: {} },
          result: {},
        },
      },
      render: (args, value) => {
        if (args.action === 'list') return text(renderEnvs(value?.envs ?? []))
        return text(show(value?.result ?? { ok: true }))
      },
    },
    async execute(args) {
      if (args.action === 'list') {
        return { envs: await engine.envsList(args.alias, args.searchValue) }
      }
      if (args.action === 'create') {
        const rows = Array.isArray(args.envs) ? args.envs : []
        if (rows.length === 0) throw new QinglongError('create 需要 envs 数组')
        const clean = rows.map(row => {
          if (typeof row?.name !== 'string' || row.name.trim() === '') throw new QinglongError('每个环境变量都需要 name')
          if (typeof row?.value !== 'string') throw new QinglongError(`环境变量 ${row.name} 缺少 value`)
          return {
            name: row.name.trim(),
            value: row.value,
            ...(typeof row.remarks === 'string' ? { remarks: row.remarks } : {}),
            ...(Array.isArray(row.labels) ? { labels: row.labels } : {}),
          }
        })
        return { result: await engine.envsCreate(args.alias, clean) }
      }
      if (args.action === 'update') {
        const env = args.env
        if (typeof env !== 'object' || env === null || !Number.isInteger(Number(env.id))) {
          throw new QinglongError('update 需要 env.id')
        }
        const patch = { ...env }
        delete patch.id
        return { result: await engine.envsUpdate(args.alias, Number(env.id), patch) }
      }
      if (args.action === 'delete') return { result: await engine.envsRemove(args.alias, ids(args)) }
      return { result: await engine.envsToggle(args.alias, args.action, ids(args)) }
    },
  }
}

/** Scheduled-task management. */
export function cronopsCronsTool(engine) {
  return {
    name: 'cronops_crons',
    description: 'Manage one panel\'s scheduled tasks: list, get, create, update, run, stop, enable, disable, delete, read the execution log, and preview a schedule expression. run returns once the panel accepts the trigger; it does not wait for the script to finish. Writes change the real panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'run', 'stop', 'enable', 'disable', 'delete', 'log', 'preview'],
          description: 'Operation to perform.',
        },
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
        searchValue: { type: 'string', description: 'list: fuzzy match on name/command.' },
        page: { type: 'integer', description: 'list: page number (1-based).' },
        size: { type: 'integer', description: 'list: page size.' },
        id: { type: 'integer', description: 'get/update/log: task id.' },
        ids: { type: 'array', items: { type: 'integer' }, description: 'run/stop/enable/disable/delete: task ids.' },
        cron: {
          type: 'object',
          additionalProperties: true,
          description: 'create: { name?, command, schedule, labels?, task_before?, task_after?, work_dir?, allow_multiple_instances? }.',
        },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'update: fields to change; the current task is read and merged (command and schedule stay complete).',
        },
        offset: { type: 'integer', description: 'log: byte offset.' },
        limit: { type: 'integer', description: 'log: byte limit (max 1048576).' },
        tail: { type: 'boolean', description: 'log: read only the tail of the file.' },
        schedule: { type: 'string', description: 'preview: cron expression (5 or 6 fields, or @macro).' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: { type: 'array', items: {} },
          total: { type: 'integer' },
          cron: {},
          result: {},
          log: {},
          preview: {},
        },
      },
      render: (args, value) => {
        if (args.action === 'list') return text(renderCrons(value?.rows ?? [], value?.total))
        if (args.action === 'log') {
          const log = value?.log ?? {}
          const body = typeof log.content === 'string' ? log.content : ''
          return text([`status: ${log.logStatus ?? '-'}`, `offset: ${log.offset ?? '-'} / total: ${log.total ?? '-'}`, '', body.slice(-8000)].join('\n'))
        }
        return text(show(value?.cron ?? value?.preview ?? value?.result ?? { ok: true }))
      },
    },
    async execute(args) {
      switch (args.action) {
        case 'list': {
          const query = {}
          if (args.searchValue !== undefined) query.searchValue = args.searchValue
          if (args.page !== undefined) query.page = args.page
          if (args.size !== undefined) query.size = args.size
          return await engine.cronsList(args.alias, query)
        }
        case 'get':
          return { cron: await engine.cronsGet(args.alias, ids({ ...args, ids: args.id })[0]) }
        case 'create': {
          const cron = args.cron
          if (typeof cron !== 'object' || cron === null) throw new QinglongError('create 需要 cron 对象')
          if (typeof cron.command !== 'string' || cron.command.trim() === '') throw new QinglongError('cron.command 不能为空')
          if (typeof cron.schedule !== 'string' || cron.schedule.trim() === '') throw new QinglongError('cron.schedule 不能为空')
          return {
            result: await engine.cronsCreate(args.alias, {
              ...cron,
              labels: Array.isArray(cron.labels) ? cron.labels : [],
            }),
          }
        }
        case 'update': {
          const id = ids({ ...args, ids: args.id })[0]
          const patch = typeof args.patch === 'object' && args.patch !== null ? args.patch : {}
          return { result: await engine.cronsUpdate(args.alias, id, patch) }
        }
        case 'run':
        case 'stop':
        case 'enable':
        case 'disable':
          return { result: await engine.cronsAction(args.alias, args.action, ids(args)) }
        case 'delete':
          return { result: await engine.cronsRemove(args.alias, ids(args)) }
        case 'log': {
          const id = ids({ ...args, ids: args.id })[0]
          const query = {}
          if (args.offset !== undefined) query.offset = args.offset
          if (args.limit !== undefined) query.limit = args.limit
          if (args.tail !== undefined) query.tail = args.tail
          const envelope = await engine.cronsLog(args.alias, id, query)
          return {
            log: {
              content: typeof envelope.data === 'string' ? envelope.data : '',
              logStatus: envelope.logStatus,
              offset: envelope.offset,
              total: envelope.total,
              truncated: envelope.truncated,
            },
          }
        }
        case 'preview':
          if (typeof args.schedule !== 'string' || args.schedule.trim() === '') throw new QinglongError('preview 需要 schedule')
          return { preview: await engine.cronsPreview(args.alias, args.schedule) }
        default:
          throw new QinglongError(`未知 action '${args.action}'`)
      }
    },
  }
}

/** Join a panel-relative directory and a file name with single slashes. */
function joinScriptPath(dir, file) {
  return [dir, file]
    .map(part => String(part ?? '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** Short sha256, enough to compare a local file with what the panel stores. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Create-or-update a 青龙 script: POST when the file does not exist yet, PUT
 * when it does. The panel answers PUT on a missing file with `404 脚本不存在`.
 */
async function saveQinglongScript(engine, alias, dir, file, content) {
  const body = { filename: file, path: dir, content }
  try {
    return await engine.raw(alias, { method: 'PUT', path: '/scripts', body })
  } catch (error) {
    const missing = error instanceof QinglongError && (error.code === 404 || /脚本不存在/.test(error.message))
    if (!missing) throw error
    return await engine.raw(alias, { method: 'POST', path: '/scripts', body })
  }
}

/**
 * Script read/write without hand-built OpenAPI calls.
 *
 * The push case is why this exists: `/scripts/detail`, `PUT /scripts` and the
 * 呆呆 equivalents differ in path, body and error shape, and a model left to
 * compose them reaches for raw curl (wrong token, wrong body) instead. Here one
 * call takes a local file, writes it, reads it back and reports both hashes.
 */
export function cronopsScriptTool(engine) {
  return {
    name: 'cronops_script',
    description: 'Read, write, run or list panel scripts in one call — the supported way to push a local file (e.g. /path/tg.py) to a panel, no curl and no hand-built request. write takes localPath (read from disk) or content, saves it at path/file, then reads it back and returns localSha/remoteSha/verified so a silent mismatch is impossible. list shows one directory of the script tree; read returns the file text; run asks the panel to execute it. Writes change the real panel.',
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
        action: { type: 'string', enum: ['list', 'read', 'write', 'run'], description: 'Operation to perform.' },
        path: { type: 'string', description: 'Directory relative to the script root; may be empty for the root.' },
        file: { type: 'string', description: 'File name (write/read/run).' },
        localPath: { type: 'string', description: 'Absolute local file to upload; write only, takes precedence over content.' },
        content: { type: 'string', description: 'File text to upload instead of localPath.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { result: {} },
      },
      render: (args, value) => {
        const result = value?.result ?? {}
        if (args.action === 'read') {
          const head = `${result.path}（${result.bytes} 字节，sha256 ${result.sha256}）`
          return text(`${head}\n${result.content ?? ''}`)
        }
        if (args.action === 'write') {
          const verdict = result.verified === true
            ? '已回读校验：本地与面板一致'
            : '回读校验失败：面板上的内容与本地不同，务必重试或检查权限'
          return text(`${result.path}（来自 ${result.from}，${result.bytes} 字节）\n${verdict}\nlocalSha=${result.localSha} remoteSha=${result.remoteSha}`)
        }
        return text(show(result))
      },
    },
    execute: async (args) => {
      const action = String(args.action ?? '')
      const alias = typeof args.alias === 'string' && args.alias !== '' ? args.alias : undefined
      const dir = typeof args.path === 'string' ? args.path : ''
      const file = typeof args.file === 'string' ? args.file : ''
      const kind = engine.kindOf(alias)
      const qinglong = kind !== 'daidai'

      if (action === 'list') {
        const envelope = await engine.raw(alias, { method: 'GET', path: '/scripts', query: { path: dir } })
        return { result: { panel: engine.entry(alias).alias, kind, path: dir, scripts: envelope.data } }
      }

      if (action !== 'list' && file === '') throw new QinglongError(`${action} 需要 file（文件名）`)

      if (action === 'read') {
        const envelope = qinglong
          ? await engine.raw(alias, { method: 'GET', path: '/scripts/detail', query: { path: dir, file } })
          : await engine.raw(alias, { method: 'GET', path: '/scripts/content', query: { path: joinScriptPath(dir, file) } })
        const body = typeof envelope.data === 'string' ? envelope.data : show(envelope.data)
        return {
          result: {
            panel: engine.entry(alias).alias, kind, path: joinScriptPath(dir, file),
            bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body), content: body,
          },
        }
      }

      if (action === 'write') {
        let body
        let origin
        if (typeof args.localPath === 'string' && args.localPath !== '') {
          body = readFileSync(args.localPath, 'utf8')
          origin = args.localPath
        } else if (typeof args.content === 'string') {
          body = args.content
          origin = 'content'
        } else {
          throw new QinglongError('write 需要 localPath（本地文件）或 content')
        }
        // Qinglong splits create and update: PUT only rewrites a file that
        // already exists (404 脚本不存在 otherwise) and POST creates it. A
        // caller guessing one verb gets 404 on half of its pushes.
        const saved = qinglong
          ? await saveQinglongScript(engine, alias, dir, file, body)
          : await engine.raw(alias, { method: 'PUT', path: '/scripts/content', body: { path: joinScriptPath(dir, file), content: body } })
        // Read back: a panel that answered 200 but stored something else is a
        // failure the caller must see, not a success with a stale file.
        const readBack = qinglong
          ? await engine.raw(alias, { method: 'GET', path: '/scripts/detail', query: { path: dir, file } })
          : await engine.raw(alias, { method: 'GET', path: '/scripts/content', query: { path: joinScriptPath(dir, file) } })
        const remote = typeof readBack.data === 'string' ? readBack.data : ''
        return {
          result: {
            panel: engine.entry(alias).alias,
            kind,
            path: joinScriptPath(dir, file),
            from: origin,
            bytes: Buffer.byteLength(body, 'utf8'),
            localSha: sha256(body),
            remoteSha: remote === '' ? '(空)' : sha256(remote),
            verified: remote === body,
            panelResponse: saved.code ?? saved,
          },
        }
      }

      if (action === 'run') {
        const envelope = qinglong
          ? await engine.raw(alias, { method: 'PUT', path: '/scripts/run', body: { filename: file, path: dir } })
          : await engine.raw(alias, { method: 'POST', path: '/scripts/run', body: { path: joinScriptPath(dir, file) } })
        return {
          result: {
            panel: engine.entry(alias).alias, kind, path: joinScriptPath(dir, file),
            triggered: true, panelResponse: envelope.data ?? envelope.code,
          },
        }
      }

      throw new QinglongError(`未知 action '${action}'`)
    },
  }
}

/** Generic OpenAPI bridge for the resources the UI does not cover. */
/**
 * One-line usage cheatsheet per resource, appended when a call fails: models
 * keep inventing `/envs/detail`-style paths, and the panels answer with a bare
 * `Validation failed`.
 */
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
function resourceHint(kind, path) {
  const segment = '/' + (path.split('/').filter(Boolean)[0] ?? '')
  return RESOURCE_HINTS[`${kind}:${segment}`]
}

/**
 * Append an actionable hint to a 404/403 from the generic bridge: the model
 * usually guessed a path that the product spells differently.
 * @param error - the thrown value.
 * @param kind - panel product behind the alias.
 * @param path - the path the caller asked for.
 * @returns the original error (same instance) after its message is amended.
 */
function withPathHint(error, kind, path) {
  if (!(error instanceof QinglongError)) return error
  // Qinglong answers business failures with HTTP 200 + a `code`, so the code
  // is the reliable status here (Daidai sends real HTTP statuses and no code).
  const status = error.code ?? error.status
  const base = error.message
  let message = base

  // A retired route still answers with a code + a replacement hint from the
  // panel; restate the exact call, including the fields it requires.
  if (status === 410 && !message.includes('path=')) {
    message += kind === 'daidai'
      ? '；读取脚本请用 GET /scripts/content?path=<文件相对路径>'
      : '；读取脚本请用 GET /scripts/detail?path=<目录，可为空>&file=<文件名>'
  }

  // Celebrate validation failures only say "Validation failed"; name the fields.
  if (status === 400 && /validation failed|参数|required/i.test(base)) {
    const required = {
      'qinglong:/scripts/detail': '需要 query：path（目录，可为空）+ file（文件名）',
      'qinglong:/logs/detail': '需要 query：path + file',
      'qinglong:/scripts': 'PUT 保存需要 body：{filename, path, content}',
      'qinglong:/envs': 'PUT 更新需要 body：{id, name, value}；按 id 取单条用 GET /envs/<id>',
      'qinglong:/crons': 'PUT 更新需要 body：{id, command, schedule}',
      'daidai:/scripts/content': 'GET 需要 query path；PUT 需要 body {path, content}',
    }
    const hint = required[`${kind}:${path}`]
    if (hint !== undefined && !message.includes(hint.slice(0, 6))) {
      message += '；' + hint
    } else if (hint === undefined && !message.includes('必填')) {
      message += '；面板拒绝了参数，检查该路径的必填字段（目录/文件名等）'
    }
  }

  // A wrong sub-path (e.g. /envs/detail) surfaces as validation or 404 noise;
  // name the resource's real shapes once per failure.
  const cheatsheet = resourceHint(kind, path)
  if (cheatsheet !== undefined
    && (status === 400 || status === 404 || status === 410)
    && !message.includes(cheatsheet.slice(0, 6))) {
    message += '\n该资源的用法：' + cheatsheet
  }

  if (status === 404 && !message.includes('常用')) {
    const hint = kind === 'daidai'
      ? '常用：/tasks /envs /logs /scripts /subscriptions /system/info /system/dashboard /system/backups'
      : '常用：/envs /crons /logs/detail（需 path+file）/subscriptions /scripts /system /dashboard/overview'
    message += `${message.includes(path) ? '' : `（${path}）`}；路径不存在，${hint}`
  } else if (status === 403 && !message.includes('scope')) {
    message += '；该资源不在应用凭据可用的 scope 内（青龙 /health 这类端点应用凭据永远拿不到）'
  }

  error.message = message
  return error
}

export function cronopsApiTool(engine) {
  return {
    name: 'cronops_api',
    description: `Call the panel's OpenAPI with its application credential. Resources — 青龙: ${ALLOWED_PATH_SEGMENTS.join(', ')}; 呆呆: ${DAIDAI_ALLOWED_PATH_SEGMENTS.join(', ')}. Common paths — 青龙: /envs, /envs/:id (an id lives IN the path; there is no /envs/detail), /crons, /crons/:id/log, /scripts (GET ?path= lists), /scripts/detail (GET requires BOTH path (directory, may be empty) and file (file name)), PUT /scripts {filename,path,content} to save, PUT /scripts/run {filename,path} to execute (prefer cronops_script for script read/write/run — it verifies the write and needs no request shape), /logs/detail (requires BOTH path and file), /subscriptions, /system, /dashboard/overview. 呆呆: /tasks, /envs, /logs, /scripts (GET lists, /scripts/tree for the tree, /scripts/content?path=<file> to read, PUT /scripts/content {path,content} to save, POST /scripts/run), /subscriptions, /system/info (system info is NOT /system), /system/dashboard (dashboard is NOT /dashboard), /system/backups. Refused on both: credentials, accounts, backups and the panel updater (青龙 /open/apps|auth|user|update, 呆呆 open-api|users|auth|mcp). Business failures surface as errors.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP method.',
        },
        path: {
          type: 'string',
          description: 'Resource path relative to /open, for example /subscriptions or /logs/detail or /dashboard/overview.',
        },
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
        query: { type: 'object', additionalProperties: true, description: 'Query object; array values repeat the key.' },
        body: { description: 'Request body for POST/PUT/DELETE.' },
      },
      required: ['method', 'path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { result: { type: 'object', additionalProperties: true } },
      },
      render: (_args, value) => text(show(value?.result)),
    },
    async execute(args) {
      const path = String(args.path ?? '')
      const segments = path.split('/').filter(segment => segment !== '')
      const first = segments[0]?.toLowerCase() === 'open'
        ? (segments[1] ?? '').toLowerCase()
        : (segments[0] ?? '').toLowerCase()
      if (!path.startsWith('/') || segments.length === 0) throw new QinglongError('path 必须以 "/" 开头')
      // The allow list depends on the panel product behind the alias: 青龙
      // exposes crons/…, 呆呆 exposes tasks/….
      const kind = typeof engine.kindOf === 'function' ? engine.kindOf(args.alias) : 'qinglong'
      const allowed = kind === 'daidai' ? DAIDAI_ALLOWED_PATH_SEGMENTS : ALLOWED_PATH_SEGMENTS
      const denied = kind === 'daidai' ? DAIDAI_DENIED_PATH_SEGMENTS : DENIED_PATH_SEGMENTS
      if (denied.includes(first)) {
        throw new QinglongError(`拒绝访问 /${first}：该资源涉及凭据、账号或备份，请直接在面板操作`)
      }
      if (!allowed.includes(first)) {
        throw new QinglongError(`不支持的资源 /${first}；可用：${allowed.join(', ')}`)
      }
      const method = String(args.method ?? 'GET').toUpperCase()
      try {
        const envelope = await engine.raw(args.alias, {
          method,
          path: path.replace(/^\/open/, ''),
          ...(typeof args.query === 'object' && args.query !== null ? { query: args.query } : {}),
          ...(args.body === undefined ? {} : { body: args.body }),
        })
        return { result: envelope }
      } catch (error) {
        throw withPathHint(error, kind, path)
      }
    },
  }
}

/** Build every tool, sharing one engine. */
export function buildTools(engine, store) {
  return [
    cronopsPanelsTool(engine, store),
    cronopsEnvsTool(engine),
    cronopsCronsTool(engine),
    cronopsScriptTool(engine),
    cronopsApiTool(engine),
  ]
}
