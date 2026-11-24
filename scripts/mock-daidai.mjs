/**
 * A local Daidai Panel (呆呆面板) mock, used only for verification.
 *
 * Mirrors the parts of `linzixuanzz/daidai-panel` v3.4.4 this plugin drives:
 * `POST /api/v1/open-api/token` → `{data:{access_token, expires_in}}`, real HTTP
 * statuses with `{"error": "…"}`, module scope denial (403), paged bodies
 * `{data,total,page,page_size}`, task status vocabulary (0 disabled / 0.5 queued
 * / 1 enabled / 2 running) and the batch endpoints (`task_ids` / `ids`).
 *
 * Run standalone: `node scripts/mock-daidai.mjs [port]`
 * Import:        `const mock = await startDaidaiMock({ port })`
 */

import http from 'node:http'

/** The credential the mock accepts. */
const APP_KEY = 'dd-key'
const APP_SECRET = 'dd-secret'
const TOKEN = 'dd-access-token'

/** In-memory panel state. */
const state = {
  envs: [
    { id: 1, name: 'DD_ENV', value: 'hello', remarks: 'seeded', enabled: true, group: 'demo', important: false, position: 10000, sort_order: 0 },
    { id: 2, name: 'DD_OFF', value: 'off', remarks: '', enabled: false, group: '', important: true, position: 10000, sort_order: 0 },
  ],
  scripts: {},
  tasks: [
    { id: 1, name: 'demo', command: 'task demo.js', cron_expression: '0 0 * * *', status: 1, enabled: true, labels: ['demo'], last_run_at: '2026-11-16T10:00:00Z', last_run_status: 0 },
    { id: 2, name: 'disabled', command: 'task off.js', cron_expression: '*/5 * * * *', status: 0, enabled: false, labels: [], last_run_at: null, last_run_status: null },
  ],
  nextEnvId: 3,
  nextTaskId: 3,
}

/** One JSON response. */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read a JSON body. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Module of a `/api/v1/<module>/…` path. */
function moduleOf(path) {
  const match = path.match(/^\/api\/v1\/([a-z-]+)/)
  return match === null ? '' : match[1]
}

/** Whether a row matches a keyword. */
function matches(row, keyword) {
  if (keyword === undefined || keyword === null || keyword === '') return true
  const needle = String(keyword).toLowerCase()
  return ['name', 'value', 'command', 'remarks', 'group', 'cron_expression']
    .some(key => String(row[key] ?? '').toLowerCase().includes(needle))
}

/** Page one array like Daidai does. */
function paged(rows, url) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? '20')))
  const all = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') ?? '').toLowerCase())
  const start = (page - 1) * pageSize
  return {
    data: all ? rows : rows.slice(start, start + pageSize),
    total: rows.length,
    page: all ? 1 : page,
    page_size: all ? rows.length : pageSize,
  }
}

/**
 * Start the mock.
 * @param {{ port?: number, denyScopes?: string[] }} [options]
 * @returns {Promise<{ port: number, baseUrl: string, close: () => Promise<void> }>}
 */
export async function startDaidaiMock(options = {}) {
  const denyScopes = Array.isArray(options.denyScopes) ? options.denyScopes : []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/api/v1/version' || path === '/api/version') {
      return send(res, 200, { version: '3.4.4-mock', api_version: 'v1', framework: 'gin' })
    }
    if (path === '/api/v1/health' || path === '/api/health') {
      return send(res, 200, { status: 'ok' })
    }
    if (path === '/api/v1/open-api/token' && method === 'POST') {
      const body = await readBody(req)
      if (body?.app_key !== APP_KEY || body?.app_secret !== APP_SECRET) {
        return send(res, 401, { error: '凭证无效' })
      }
      return send(res, 200, { data: { access_token: TOKEN, token_type: 'Bearer', expires_in: 86_400 } })
    }

    const authorization = req.headers.authorization
    if (authorization !== `Bearer ${TOKEN}`) {
      return send(res, 401, { error: '缺少授权令牌' })
    }
    const module = moduleOf(path)
    if (denyScopes.includes(module)) {
      return send(res, 403, { error: '应用令牌无权访问此接口' })
    }

    // ------------------------------------------------------------- probes
    if (path === '/api/v1/logs') return send(res, 200, paged([], url))
    // A flat tree that prefix-matches `path`, exactly like the real panel: a
    // listing for `helloworld` also returns root-level files.
    if (path === '/api/v1/scripts' && method === 'GET') {
      const dir = url.searchParams.get('path') ?? ''
      const files = Object.keys(state.scripts)
      const rows = dir === '' ? files : [...new Set([...files, 'notify.py', 'sendNotify.js'])].filter(name => name.startsWith(dir))
      return send(res, 200, { data: rows })
    }
    if (path === '/api/v1/scripts/content') {
      if (method === 'GET') {
        const file = url.searchParams.get('path') ?? ''
        if (state.scripts[file] === undefined) return send(res, 404, { error: '脚本不存在' })
        return send(res, 200, { data: { content: state.scripts[file], path: file, binary: false, is_binary: false }, message: 'ok' })
      }
      if (method === 'PUT') {
        const body = await readBody(req)
        if (typeof body.path !== 'string' || typeof body.content !== 'string') {
          return send(res, 400, { error: 'path 与 content 必填' })
      }
        state.scripts[body.path] = body.content
        return send(res, 200, { data: { path: body.path, binary: false, is_binary: false }, message: '保存成功' })
      }
    }
    if (path === '/api/v1/subscriptions') return send(res, 200, paged([], url))
    if (path === '/api/v1/system/info') return send(res, 200, { data: { version: '3.4.4-mock' } })
    if (path === '/api/v1/system/backups') return send(res, 200, { data: [] })

    // --------------------------------------------------------------- envs
    if (path === '/api/v1/envs' && method === 'GET') {
      const rows = state.envs.filter(row => matches(row, url.searchParams.get('keyword')))
      return send(res, 200, paged(rows, url))
    }
    if (path === '/api/v1/envs' && method === 'POST') {
      const body = await readBody(req)
      const rows = Array.isArray(body) ? body : [body]
      if (rows.length === 0) return send(res, 400, { error: '请求内容为空' })
      for (const row of rows) {
        if (typeof row?.name !== 'string' || !/^[a-zA-Z_][0-9a-zA-Z_]*$/.test(row.name)) {
          return send(res, 400, { error: '变量名格式无效' })
        }
        state.envs.push({
          id: state.nextEnvId++,
          name: row.name,
          value: row.value ?? '',
          remarks: row.remarks ?? '',
          enabled: true,
          group: row.group ?? (Array.isArray(row.groups) ? row.groups.join(',') : ''),
          important: row.important === true,
          position: 10000,
          sort_order: 0,
        })
      }
      return send(res, 200, { data: rows })
    }
    const envMatch = path.match(/^\/api\/v1\/envs\/(\d+)$/)
    if (envMatch !== null && method === 'GET') {
      const row = state.envs.find(item => item.id === Number(envMatch[1]))
      return row === undefined ? send(res, 404, { error: '环境变量不存在' }) : send(res, 200, row)
    }
    if (envMatch !== null && method === 'PUT') {
      const row = state.envs.find(item => item.id === Number(envMatch[1]))
      if (row === undefined) return send(res, 404, { error: '环境变量不存在' })
      const body = await readBody(req) ?? {}
      if (typeof body.name === 'string') row.name = body.name
      if (typeof body.value === 'string') row.value = body.value
      if (typeof body.remarks === 'string') row.remarks = body.remarks
      if (typeof body.group === 'string') row.group = body.group
      if (typeof body.important === 'boolean') row.important = body.important
      return send(res, 200, { data: row })
    }
    if (path === '/api/v1/envs/batch' && method === 'DELETE') {
      const body = await readBody(req)
      const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
      if (ids.length === 0) return send(res, 400, { error: '请求参数错误' })
      state.envs = state.envs.filter(row => !ids.includes(row.id))
      return send(res, 200, { message: `已删除 ${ids.length} 个环境变量` })
    }
    const envBatchToggle = path.match(/^\/api\/v1\/envs\/batch\/(enable|disable)$/)
    if (envBatchToggle !== null && method === 'PUT') {
      const body = await readBody(req)
      const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : []
      if (ids.length === 0) return send(res, 400, { error: '请求参数错误' })
      for (const row of state.envs) if (ids.includes(row.id)) row.enabled = envBatchToggle[1] === 'enable'
      return send(res, 200, { message: 'ok' })
    }

    // -------------------------------------------------------------- tasks
    if (path === '/api/v1/tasks' && method === 'GET') {
      const rows = state.tasks.filter(row => matches(row, url.searchParams.get('keyword')))
      return send(res, 200, paged(rows, url))
    }
    if (path === '/api/v1/tasks' && method === 'POST') {
      const body = await readBody(req)
      if (typeof body?.name !== 'string' || typeof body?.command !== 'string') {
        return send(res, 400, { error: '请求参数错误' })
      }
      const row = {
        id: state.nextTaskId++,
        name: body.name,
        command: body.command,
        cron_expression: body.cron_expression ?? '',
        status: 1,
        enabled: true,
        labels: Array.isArray(body.labels) ? body.labels : [],
        last_run_at: null,
        last_run_status: null,
        task_before: body.task_before ?? '',
        task_after: body.task_after ?? '',
        allow_multiple_instances: body.allow_multiple_instances === true,
      }
      state.tasks.push(row)
      return send(res, 200, { data: row })
    }
    if (path === '/api/v1/tasks/cron/parse' && method === 'POST') {
      const body = await readBody(req)
      const expression = typeof body?.expression === 'string' ? body.expression.trim() : ''
      if (expression === '') return send(res, 400, { error: '请求参数错误' })
      if (expression.split(/\s+/).length < 5) {
        return send(res, 200, { data: { is_valid: false, error: '表达式无效' } })
      }
      // A date the calendar never reaches: the real panel accepts the shape and
      // simply reports no future run.
      if (/^0 0 30 2 \*$/.test(expression)) {
        return send(res, 200, { data: { is_valid: true, description: '每年 2 30日 00:00', next_run_times: [], format: '标准格式 (5位)' } })
      }
      const now = Date.now()
      return send(res, 200, {
        data: {
          is_valid: true,
          description: 'mock',
          next_run_times: [now + 60_000, now + 120_000, now + 180_000].map(ms => new Date(ms).toISOString()),
          format: '标准格式 (5位)',
        },
      })
    }
    if (path === '/api/v1/tasks/batch/run' && method === 'POST') {
      const body = await readBody(req)
      const ids = Array.isArray(body?.task_ids) ? body.task_ids.map(Number) : []
      if (ids.length === 0) return send(res, 400, { error: '请求参数错误' })
      if (ids.length > 10) return send(res, 400, { error: '批量运行最多 10 个任务' })
      for (const row of state.tasks) if (ids.includes(row.id)) { row.status = 2; row.enabled = true }
      return send(res, 200, { data: { count: ids.length } })
    }
    if (path === '/api/v1/tasks/batch/delete' && method === 'DELETE') {
      const body = await readBody(req)
      const ids = Array.isArray(body?.task_ids) ? body.task_ids.map(Number) : []
      if (ids.length === 0) return send(res, 400, { error: '请求参数错误' })
      state.tasks = state.tasks.filter(row => !ids.includes(row.id))
      return send(res, 200, { data: { count: ids.length } })
    }
    const taskAction = path.match(/^\/api\/v1\/tasks\/(\d+)\/(run|stop|enable|disable)$/)
    if (taskAction !== null && method === 'PUT') {
      const row = state.tasks.find(item => item.id === Number(taskAction[1]))
      if (row === undefined) return send(res, 404, { error: '任务不存在' })
      const action = taskAction[2]
      if (action === 'run') { row.status = 2; row.enabled = true }
      if (action === 'stop') row.status = 1
      if (action === 'enable') { row.status = 1; row.enabled = true }
      if (action === 'disable') { row.status = 0; row.enabled = false }
      return send(res, 200, { data: row })
    }
    const taskLog = path.match(/^\/api\/v1\/tasks\/(\d+)\/latest-log$/)
    if (taskLog !== null && method === 'GET') {
      const row = state.tasks.find(item => item.id === Number(taskLog[1]))
      if (row === undefined) return send(res, 404, { error: '该任务还没有日志记录' })
      return send(res, 200, {
        data: {
          id: 1,
          task_id: row.id,
          status: 0,
          content: `[mock] ${row.command}\n运行时间: ${new Date().toISOString()}\n结果: 成功\n`,
        },
      })
    }
    const taskFiles = path.match(/^\/api\/v1\/tasks\/(\d+)\/log-files$/)
    if (taskFiles !== null && method === 'GET') {
      return send(res, 200, { data: [] })
    }
    const taskMatch = path.match(/^\/api\/v1\/tasks\/(\d+)$/)
    if (taskMatch !== null && method === 'PUT') {
      const row = state.tasks.find(item => item.id === Number(taskMatch[1]))
      if (row === undefined) return send(res, 404, { error: '任务不存在' })
      const body = await readBody(req) ?? {}
      if (typeof body.name === 'string') row.name = body.name
      if (typeof body.command === 'string') row.command = body.command
      if (typeof body.cron_expression === 'string') row.cron_expression = body.cron_expression
      if (Array.isArray(body.labels)) row.labels = body.labels
      if (typeof body.task_before === 'string') row.task_before = body.task_before
      if (typeof body.task_after === 'string') row.task_after = body.task_after
      if (typeof body.allow_multiple_instances === 'boolean') row.allow_multiple_instances = body.allow_multiple_instances
      return send(res, 200, { data: row })
    }
    if (taskMatch !== null && method === 'DELETE') {
      state.tasks = state.tasks.filter(item => item.id !== Number(taskMatch[1]))
      return send(res, 200, { message: '任务已删除' })
    }

    return send(res, 404, { error: `mock: 未实现的接口 ${method} ${path}` })
  })

  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] ?? '5799')
  const mock = await startDaidaiMock({ port })
  console.log(`mock daidai listening on ${mock.baseUrl} (app_key=${APP_KEY}, app_secret=${APP_SECRET})`)
}
