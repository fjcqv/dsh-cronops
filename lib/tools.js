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
  return ['alias | kind | baseUrl | auth | appKey | default', '--- | --- | --- | --- | --- | ---', ...rows].join('\n')
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

/** Generic OpenAPI bridge for the resources the UI does not cover. */
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
  if (status === 404 && !base.includes('常用')) {
    const hint = kind === 'daidai'
      ? '常用：/tasks /envs /logs /scripts /subscriptions /system/info /system/dashboard /system/backups'
      : '常用：/envs /crons /logs/detail（需 path+file）/subscriptions /scripts /system /dashboard/overview'
    error.message = `${base}${base.includes(path) ? '' : `（${path}）`}；路径不存在，${hint}`
  } else if (status === 403 && !base.includes('scope')) {
    error.message = `${base}；该资源不在应用凭据可用的 scope 内（青龙 /health 这类端点应用凭据永远拿不到）`
  }
  return error
}

export function cronopsApiTool(engine) {
  return {
    name: 'cronops_api',
    description: `Call the panel's OpenAPI with its application credential. Resources — 青龙: ${ALLOWED_PATH_SEGMENTS.join(', ')}; 呆呆: ${DAIDAI_ALLOWED_PATH_SEGMENTS.join(', ')}. Common paths — 青龙: /envs, /crons, /crons/:id/log, /logs/detail (requires BOTH path and file), /subscriptions, /scripts, /system, /dashboard/overview. 呆呆: /tasks, /envs, /logs, /scripts, /subscriptions, /system/info (system info is NOT /system), /system/dashboard (dashboard is NOT /dashboard), /system/backups. Refused on both: credentials, accounts, backups and the panel updater (青龙 /open/apps|auth|user|update, 呆呆 open-api|users|auth|mcp). Business failures surface as errors.`,
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
    cronopsApiTool(engine),
  ]
}
