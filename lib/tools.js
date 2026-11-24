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

import { proxyPolicy, READ_ONLY_POSTS } from './protocol.js'
import { PanelError as QinglongError, joinScriptPath } from './panels/driver.js'
import { withPathHint } from './guidance.js'
import { localIso } from './cron-preview.js'
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
        const defaultAlias = store.defaultAlias()
        return { panels: store.list().map(entry => store.summarize(entry, defaultAlias)) }
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
      // 青龙 accepts these and answers no body at all; report what was accepted
      // instead of handing the agent `null` and inviting a blind retry.
      const target = ids(args)
      if (args.action === 'delete') {
        const removed = await engine.envsRemove(args.alias, target)
        return { result: removed ?? { ok: true, deleted: target } }
      }
      const toggled = await engine.envsToggle(args.alias, args.action, target)
      return { result: toggled ?? { ok: true, action: args.action, ids: target } }
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
        schedule: { type: 'string', description: 'preview: 5-field cron「分 时 日 月 周」，或面板自己支持的 @宏（青龙支持，呆呆不支持）。六段（含秒）两个面板都不收。' },
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
        case 'disable': {
          const accepted = await engine.cronsAction(args.alias, args.action, ids(args))
          // `undefined` is not JSON: a panel that answers with an empty body
          // would otherwise turn a success into an invalid tool result.
          return { result: accepted ?? { ok: true, action: args.action, ids: ids(args) } }
        }
        case 'delete': {
          const accepted = await engine.cronsRemove(args.alias, ids(args))
          return { result: accepted ?? { ok: true, deleted: ids(args) } }
        }
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
        case 'preview': {
          if (typeof args.schedule !== 'string' || args.schedule.trim() === '') throw new QinglongError('preview 需要 schedule')
          const preview = await engine.cronsPreview(args.alias, args.schedule)
          // 青龙 previews locally (UTC) and 呆呆 asks its own parser (local
          // offset); the caller must not see two spellings of the same moment.
          return {
            preview: {
              ...preview,
              times: (Array.isArray(preview?.times) ? preview.times : [])
                .map(entry => (Number.isNaN(Date.parse(entry)) ? String(entry) : localIso(new Date(entry)))),
            },
          }
        }
        default:
          throw new QinglongError(`未知 action '${args.action}'`)
      }
    },
  }
}


/** Short sha256, enough to compare a local file with what the panel stores. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Script text lives in a different envelope per product: 青龙 answers
 * `{data: '<text>'}`, 呆呆 answers `{data: {content, path, binary, is_binary}}`.
 * Collapse both before hashing — otherwise the read-back check compares a hash
 * of JSON with a hash of the file and reports a successful write as a failure.
 * @param envelope - raw panel body.
 * @returns the script text, or '' when the panel returned none.
 */
function scriptText(envelope) {
  for (const value of [envelope?.data, envelope?.data?.content, envelope?.content]) {
    if (typeof value === 'string') return value
  }
  return ''
}


/**
 * Script read/write without hand-built OpenAPI calls.
 *
 * The push case is why this exists: `/scripts/detail`, `PUT /scripts` and the
 * 呆呆 equivalents differ in path, body and error shape, and a model left to
 * compose them reaches for raw curl (wrong token, wrong body) instead. Here one
 * call takes a local file, writes it, reads it back and reports both hashes.
 */
/**
 * 呆呆's `/scripts` is a flat tree and prefix-matches the `path` query, so a
 * listing for `helloworld` also returns root-level `notify.py`. Keep only the
 * entries under the requested directory; 青龙 already scopes its answer.
 * @param data - the panel's listing (array for 呆呆, `{dirs, files}` for 青龙).
 * @param dir - requested directory, '' for the root.
 * @returns the same shape, filtered.
 */
/** Upper bound on one listing; the panel tree can hold thousands of files. */
const MAX_LISTED = 200

function inDirectory(data, dir) {
  if (!Array.isArray(data)) return data
  // 青龙 answers with a tree of `{title, key, type, children}` nodes; 呆呆
  // answers with a flat list of `{path, name, size}`. Flatten the tree so both
  // products return the same list, then keep only what the caller asked for.
  const nested = data.some(node => node?.type === 'directory' || Array.isArray(node?.children))
  const rows = nested ? flattenTree(data) : data.map(normalizeRow)
  if (dir === '') return rows
  return rows.filter(row => row.path === dir || row.path.startsWith(`${dir}/`))
}

/**
 * One row shape for both products: 青龙 keys rows as `dir/file` and dates them
 * with `createTime`, 呆呆 carries `path` and `mtime`.
 * @param row - a listing row (string or object).
 * @returns `{path, name, size?, mtime?}`.
 */
function normalizeRow(row) {
  if (typeof row === 'string') return { path: row, name: row.split('/').pop() }
  const path = String(row?.path ?? row?.key ?? '')
  const name = String(row?.name ?? row?.title ?? row?.filename ?? path.split('/').pop() ?? '')
  const mtime = typeof row?.mtime === 'number'
    ? row.mtime
    : typeof row?.createTime === 'number' ? Math.floor(row.createTime / 1000) : undefined
  return {
    path,
    name,
    ...(typeof row?.size === 'number' ? { size: row.size } : {}),
    ...(mtime === undefined ? {} : { mtime }),
  }
}

/**
 * Walk a 青龙 script tree into `{path, name, size, mtime}` leaves.
 * @param nodes - top-level tree nodes.
 * @returns the file rows, depth-first.
 */
function flattenTree(nodes) {
  const rows = []
  const walk = (list, prefix) => {
    for (const node of Array.isArray(list) ? list : []) {
      const key = String(node?.key ?? node?.title ?? '')
      if (key === '') continue
      // 青龙 keys every node with its full relative path, so prefixing it again
      // produced `helloworld/helloworld/hello.js`. Only a bare name needs the
      // walk's prefix.
      const full = prefix === '' || key.includes('/') ? key : `${prefix}/${key}`
      if (node?.type === 'directory' || Array.isArray(node?.children)) {
        walk(node.children ?? [], full)
        continue
      }
      rows.push({
        path: full,
        name: String(node?.title ?? key.split('/').pop()),
        size: node?.size,
        mtime: typeof node?.createTime === 'number' ? Math.floor(node.createTime / 1000) : undefined,
      })
    }
  }
  walk(nodes, '')
  return rows
}

export function cronopsScriptTool(engine) {
  return {
    name: 'cronops_script',
    description: 'Read, write, run or list panel scripts in one call — the supported way to push a local file (e.g. /path/tg.py) to a panel, no curl and no hand-built request. write takes localPath (read from disk) or content, saves it at path/file, then reads it back and returns localSha/remoteSha/verified so a silent mismatch is impossible. list shows one directory of the script tree; read returns the file text; run asks the panel to execute it. Writes change the real panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'run'], description: 'Operation to perform.' },
        alias: { type: 'string', description: 'Panel alias; omit for the default panel.' },
        path: { type: 'string', description: 'Directory relative to the script root; may be empty for the root.' },
        dir: { type: 'string', description: 'Alias of `path` — the same directory, either argument works.' },
        file: { type: 'string', description: 'File name (write/read/run).' },
        localPath: { type: 'string', description: 'Absolute local file to upload; write only, takes precedence over content.' },
        content: { type: 'string', description: 'File text to upload instead of localPath.' },
      },
      required: ['action'],
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
        if (args.action === 'list' && result.truncated === true) {
          return text(`${show(result)}\n（共 ${result.total} 项，已截断；用 path 指定目录再列一次）`)
        }
        return text(show(result))
      },
    },
    execute: async (args) => {
      const action = String(args.action ?? '')
      const alias = typeof args.alias === 'string' && args.alias !== '' ? args.alias : undefined
      // `path` is the directory argument; `dir` is accepted as well because
      // "dir: helloworld" is what a caller naturally writes, and an ignored
      // argument turned into a confusing "文件不存在".
      const dir = typeof args.path === 'string' && args.path !== ''
        ? args.path
        : typeof args.dir === 'string' ? args.dir : ''
      const file = typeof args.file === 'string' ? args.file : ''
      const kind = engine.kindOf(alias)

      if (action === 'list') {
        const envelope = await engine.scriptsList(alias, dir)
        const rows = inDirectory(envelope.data, dir)
        const listed = rows.length > MAX_LISTED ? rows.slice(0, MAX_LISTED) : rows
        return {
          result: {
            panel: engine.entry(alias).alias, kind, path: dir, scripts: listed, total: rows.length,
            ...(listed.length === rows.length ? {} : { truncated: true }),
          },
        }
      }

      if (action !== 'list' && file === '') throw new QinglongError(`${action} 需要 file（文件名）`)

      if (action === 'read') {
        const text = scriptText(await engine.scriptsRead(alias, dir, file))
        if (text === '') {
          // 青龙 answers a missing file with HTTP 200 and `data: ''` — the same
          // body an empty file returns. Only the listing can tell them apart,
          // and "0 bytes, success" for a typo is worse than one extra request.
          const wanted = joinScriptPath(dir, file)
          const rows = inDirectory((await engine.scriptsList(alias, dir)).data, dir)
          if (!rows.some(row => row.path === wanted)) throw new QinglongError(`文件不存在：${wanted}`)
        }
        return {
          result: {
            panel: engine.entry(alias).alias, kind, path: joinScriptPath(dir, file),
            bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), content: text,
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
        // Which verb creates and which rewrites is the product's business; the
        // driver picks. A caller guessing one verb would get a 404 on half of
        // its pushes.
        const saved = await engine.scriptsWrite(alias, dir, file, body)
        // Read back: a panel that answered 200 but stored something else is a
        // failure the caller must see, not a success with a stale file.
        const remote = scriptText(await engine.scriptsRead(alias, dir, file))
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
        const envelope = await engine.scriptsRun(alias, dir, file)
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
 * Resources whose writes already have a dedicated tool. GET stays open here —
 * reading has no side effect and the raw shape is sometimes what the caller
 * needs — while writes are refused, so the two paths cannot diverge.
 */
const WRITE_OWNERS = {
  qinglong: {
    envs: { tool: 'cronops_envs', why: '青龙 PUT /envs 要全量 {id,name,value}，它会先读后合并' },
    crons: { tool: 'cronops_crons', why: '它会归一 id 数组、日志尾读与 preview 字段' },
    scripts: { tool: 'cronops_script', why: '它会处理 PUT 404→POST 回退并回读 sha256 校验' },
  },
  daidai: {
    envs: { tool: 'cronops_envs', why: '它会归一 batch 语义与分页参数' },
    tasks: { tool: 'cronops_crons', why: '呆呆批量运行单次 ≤10，它会分块' },
    scripts: { tool: 'cronops_script', why: '它会拼好脚本路径并回读 sha256 校验' },
  },
}

export function cronopsApiTool(engine) {
  return {
    name: 'cronops_api',
    description: `Call the panel's OpenAPI with its application credential — the escape hatch for resources the console does not render. Reads reach every allowed resource. Writes are accepted only where no dedicated tool exists: 青龙 subscriptions / configs / logs / dependencies / system / dashboard, 呆呆 logs / subscriptions / system/*. Writes to envs, crons, tasks and scripts are refused here on purpose — cronops_envs, cronops_crons and cronops_script normalise what the panel really wants (青龙 read-modify-write for PUT /envs, 呆呆 ≤10 batching for batch run, PUT-404→POST plus a sha256 read-back for scripts) and a raw forward cannot. A rejected path or shape comes back with the exact call to use. Credentials, accounts, backups and the panel updater are refused on both products. Business failures surface as errors.`,
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
      const kind = engine.kindOf(args.alias)
      const { allowed, denied } = proxyPolicy(kind)
      if (denied.includes(first)) {
        throw new QinglongError(`拒绝访问 /${first}：该资源涉及凭据、账号或备份，请直接在面板操作`)
      }
      if (!allowed.includes(first)) {
        throw new QinglongError(`不支持的资源 /${first}；可用：${allowed.join(', ')}`)
      }
      const method = String(args.method ?? 'GET').toUpperCase()
      // Two writers for one resource is how a panel gets corrupted: the
      // dedicated tools normalise the request (read-modify-write, batching,
      // read-back), this bridge forwards it raw. Keep the reads, refuse the
      // writes that already have an owner.
      const resource = segments[0]?.toLowerCase() === 'open' ? segments.slice(1) : segments
      const requestPath = `/${resource.join('/')}`.toLowerCase()
      const readOnly = (READ_ONLY_POSTS[kind] ?? []).some(entry => entry.toLowerCase() === requestPath)
      const owner = (WRITE_OWNERS[kind] ?? {})[first]
      if (method !== 'GET' && owner !== undefined && !readOnly) {
        throw new QinglongError(`写 /${first} 请用 ${owner.tool}：${owner.why}；本桥只原样转发，绕过这些处理会把面板写坏`)
      }
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
