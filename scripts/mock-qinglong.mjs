/**
 * A local Qinglong OpenAPI mock, used only for verification.
 *
 * It implements the endpoints this plugin drives — `/open/auth/token`,
 * `/open/system`, envs, crons (including run/stop/log/preview) — with the real
 * envelope semantics: HTTP 200 plus `{ code, message }` for business failures,
 * Bearer-token enforcement, and `data` payloads shaped like the panel's.
 *
 * Run standalone: `node scripts/mock-qinglong.mjs [port]`
 * Import:        `const mock = await startMock({ port: 5799 })`
 */

import http from 'node:http'

/** The credential the mock accepts. */
const CLIENT_ID = 'mock-client'
const CLIENT_SECRET = 'mock-secret'
const TOKEN = 'mock-token'

/** In-memory state. */
const state = {
  envs: [
    { id: 1, name: 'MOCK_ENV', value: 'hello', remarks: 'seeded', status: 0, position: 4500000000000000, isPinned: 0, labels: ['demo'] },
    { id: 2, name: 'MOCK_DISABLED', value: 'off', remarks: '', status: 1, position: 4510000000000000, isPinned: 0, labels: [] },
  ],
  crons: [
    { id: 1, name: 'demo', command: 'task demo.js', schedule: '0 0 * * *', status: 1, isDisabled: 0, labels: [], last_execution_time: 1793000000, log_path: 'demo' },
    { id: 2, name: 'disabled', command: 'task off.js', schedule: '*/5 * * * *', status: 2, isDisabled: 1, labels: ['demo'], last_execution_time: null, log_path: 'off' },
  ],
  nextEnvId: 3,
  nextCronId: 3,
  /** every `/open/dependencies` request this process served: { type, search } */
  dependencyRequests: [],
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

/** Write one JSON envelope. */
function send(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Business failure with HTTP 200 (the panel's own convention). */
function businessFailure(res, message, code = 400) {
  send(res, { code, message })
}

/** Search filter on a row. */
function matches(row, searchValue) {
  if (searchValue === undefined || searchValue === null || searchValue === '') return true
  const needle = String(searchValue).toLowerCase()
  return ['name', 'value', 'command', 'remarks'].some(key => String(row[key] ?? '').toLowerCase().includes(needle))
}

/**
 * Start the mock.
 * @param {{ port?: number }} [options] - listen port (0 picks a free one).
 * @returns {Promise<{ port: number, baseUrl: string, close: () => Promise<void> }>}
 */
export async function startMock(options = {}) {
  const denyScopes = Array.isArray(options.denyScopes) ? options.denyScopes : []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/open/auth/token') {
      const clientId = url.searchParams.get('client_id')
      const clientSecret = url.searchParams.get('client_secret')
      if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
        return businessFailure(res, 'client_id 或 client_seret 有误')
      }
      return send(res, {
        code: 200,
        data: { token: TOKEN, token_type: 'Bearer', expiration: Math.floor(Date.now() / 1000) + 3600 },
      })
    }

    if (path === '/open/system' && (req.headers.authorization === undefined)) {
      return send(res, { code: 200, data: { isInitialized: true, version: '2.24.0-mock', branch: 'mock' } })
    }

    const authorization = req.headers.authorization
    if (authorization !== `Bearer ${TOKEN}`) {
      return send(res, { code: 401, message: '请先登录' }, 401)
    }

    if (path === '/open/system') {
      return send(res, { code: 200, data: { isInitialized: true, version: '2.24.0-mock', branch: 'mock' } })
    }
    // Scope simulation: a listed resource answers 403 like a real app without
    // that scope, so the plugin's permission probe can be exercised.
    const scopeMatch = path.match(/^\/open\/([a-z]+)/)
    if (scopeMatch !== null && denyScopes.includes(scopeMatch[1])) {
      return send(res, { code: 403, message: '暂无权限' })
    }
    if (path === '/open/dependencies') {
      const type = url.searchParams.get('type')
      const search = url.searchParams.get('searchValue')
      state.dependencyRequests.push({ type, search })
      if (options.slowDependencies === true) {
        // A full scan on a real panel takes 10-16 s; 1.5 s is enough to make a
        // short probe ceiling bite without slowing the suite down.
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      const rows = type === 'python3'
        ? [{ name: 'requests', type: 1, status: 1 }]
        : type === 'nodejs'
          ? [{ name: 'tough-cookie', type: 0, status: 1 }]
          : [{ name: 'tough-cookie', type: 0, status: 1 }, { name: 'requests', type: 1, status: 1 }]
      return send(res, { code: 200, data: rows })
    }
    if (path === '/open/subscriptions') {
      return send(res, { code: 200, data: [] })
    }
    if (path === '/open/configs/files') {
      return send(res, { code: 200, data: [] })
    }
    if (path === '/open/scripts') {
      return send(res, { code: 200, data: [] })
    }
    if (path === '/open/logs') {
      return send(res, { code: 200, data: [] })
    }
    if (path === '/open/dashboard/overview') {
      return send(res, { code: 200, data: {} })
    }
    if (path === '/open/apps') {
      return businessFailure(res, '暂无权限', 403)
    }
    if (path === '/open/user') {
      return businessFailure(res, '暂无权限', 403)
    }

    // ---------------------------------------------------------------- envs
    if (path === '/open/envs' && method === 'GET') {
      const searchValue = url.searchParams.get('searchValue')
      return send(res, { code: 200, data: state.envs.filter(row => matches(row, searchValue)) })
    }
    if (path === '/open/envs' && method === 'POST') {
      const body = await readBody(req)
      if (!Array.isArray(body) || body.length === 0) return businessFailure(res, '参数不正确')
      for (const item of body) {
        if (typeof item.name !== 'string' || !/^[a-zA-Z_][0-9a-zA-Z_]*$/.test(item.name)) {
          return businessFailure(res, '变量名不合法')
        }
        state.envs.push({
          id: state.nextEnvId++,
          name: item.name,
          value: item.value ?? '',
          remarks: item.remarks ?? '',
          status: 0,
          position: 4500000000000000,
          isPinned: 0,
          labels: Array.isArray(item.labels) ? item.labels : [],
        })
      }
      return send(res, { code: 200, data: [] })
    }
    if (path === '/open/envs' && method === 'PUT') {
      const body = await readBody(req)
      const row = state.envs.find(item => item.id === Number(body?.id))
      if (row === undefined) return businessFailure(res, '环境变量不存在')
      if (typeof body.name !== 'string' || typeof body.value !== 'string' || body.name === '') {
        return businessFailure(res, '更新必须提供 id/name/value')
      }
      Object.assign(row, { name: body.name, value: body.value, remarks: body.remarks ?? row.remarks })
      if (Array.isArray(body.labels)) row.labels = body.labels
      return send(res, { code: 200, data: row })
    }
    if (path === '/open/envs' && method === 'DELETE') {
      const body = await readBody(req)
      const ids = Array.isArray(body) ? body : [body]
      state.envs = state.envs.filter(row => !ids.includes(row.id))
      return send(res, { code: 200, data: ids })
    }
    if ((path === '/open/envs/enable' || path === '/open/envs/disable') && method === 'PUT') {
      const body = await readBody(req)
      const ids = Array.isArray(body) ? body : [body]
      const status = path.endsWith('enable') ? 0 : 1
      for (const row of state.envs) if (ids.includes(row.id)) row.status = status
      return send(res, { code: 200, data: ids })
    }
    const envMatch = path.match(/^\/open\/envs\/(\d+)$/)
    if (envMatch !== null && method === 'GET') {
      const row = state.envs.find(item => item.id === Number(envMatch[1]))
      if (row === undefined) return businessFailure(res, '环境变量不存在', 404)
      return send(res, { code: 200, data: row })
    }

    // --------------------------------------------------------------- crons
    if (path === '/open/crons' && method === 'GET') {
      const searchValue = url.searchParams.get('searchValue')
      const page = Number(url.searchParams.get('page') ?? '1')
      const size = Number(url.searchParams.get('size') ?? '20')
      const filtered = state.crons.filter(row => matches(row, searchValue))
      const start = (page - 1) * size
      return send(res, {
        code: 200,
        data: { data: filtered.slice(start, start + size), total: filtered.length, page, size },
      })
    }
    if (path === '/open/crons' && method === 'POST') {
      const body = await readBody(req)
      if (typeof body?.command !== 'string' || typeof body?.schedule !== 'string') {
        return businessFailure(res, 'command 和 schedule 必填')
      }
      const row = {
        id: state.nextCronId++,
        name: body.name ?? '',
        command: body.command,
        schedule: body.schedule,
        status: 1,
        isDisabled: 0,
        labels: Array.isArray(body.labels) ? body.labels : [],
        last_execution_time: null,
        log_path: String(state.nextCronId),
      }
      state.crons.push(row)
      return send(res, { code: 200, data: row })
    }
    if (path === '/open/crons' && method === 'PUT') {
      const body = await readBody(req)
      const row = state.crons.find(item => item.id === Number(body?.id))
      if (row === undefined) return businessFailure(res, '任务不存在')
      if (typeof body.command !== 'string' || typeof body.schedule !== 'string') {
        return businessFailure(res, '更新必须带 command 和 schedule')
      }
      Object.assign(row, {
        name: body.name ?? row.name,
        command: body.command,
        schedule: body.schedule,
        labels: Array.isArray(body.labels) ? body.labels : row.labels,
        task_before: body.task_before,
        task_after: body.task_after,
        work_dir: body.work_dir,
        allow_multiple_instances: body.allow_multiple_instances ?? row.allow_multiple_instances,
      })
      return send(res, { code: 200, data: row })
    }
    if (path === '/open/crons' && method === 'DELETE') {
      const body = await readBody(req)
      const ids = Array.isArray(body) ? body : [body]
      state.crons = state.crons.filter(row => !ids.includes(row.id))
      return send(res, { code: 200, data: ids })
    }
    if (path === '/open/crons/preview' && method === 'GET') {
      const schedule = url.searchParams.get('schedule')
      if (schedule === null || schedule.trim() === '') return businessFailure(res, 'Cron表达式格式有误')
      const now = Date.now()
      return send(res, {
        code: 200,
        data: { times: [now + 60_000, now + 120_000, now + 180_000], timezone: 'Asia/Shanghai' },
      })
    }
    const actionMatch = path.match(/^\/open\/crons\/(run|stop|enable|disable)$/)
    if (actionMatch !== null && method === 'PUT') {
      const body = await readBody(req)
      const ids = Array.isArray(body) ? body : [body]
      if (ids.length === 0) return businessFailure(res, 'ids 不能为空')
      for (const row of state.crons) {
        if (!ids.includes(row.id)) continue
        if (actionMatch[1] === 'run') row.status = 0
        if (actionMatch[1] === 'stop') row.status = 1
        if (actionMatch[1] === 'enable') { row.isDisabled = 0; row.status = 1 }
        if (actionMatch[1] === 'disable') { row.isDisabled = 1; row.status = 2 }
      }
      return send(res, { code: 200, data: ids })
    }
    const logMatch = path.match(/^\/open\/crons\/(\d+)\/log$/)
    if (logMatch !== null && method === 'GET') {
      const row = state.crons.find(item => item.id === Number(logMatch[1]))
      if (row === undefined) return businessFailure(res, '任务不存在', 404)
      const content = `[mock] ${row.command}\n运行时间: ${new Date().toISOString()}\n结果: 成功\n`
      const limit = Number(url.searchParams.get('limit') ?? '0')
      const sliced = limit > 0 ? content.slice(-limit) : content
      return send(res, {
        code: 200,
        data: sliced,
        logStatus: 'idle',
        offset: 0,
        nextOffset: sliced.length,
        total: content.length,
        truncated: false,
      })
    }
    const cronMatch = path.match(/^\/open\/crons\/(\d+)$/)
    if (cronMatch !== null && method === 'GET') {
      const row = state.crons.find(item => item.id === Number(cronMatch[1]))
      if (row === undefined) return businessFailure(res, '任务不存在', 404)
      return send(res, { code: 200, data: row })
    }

    return businessFailure(res, `mock: 未实现的接口 ${method} ${path}`, 404)
  })

  state.dependencyRequests = []
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    /** Requests this instance served to `/open/dependencies`, in order. */
    dependencyRequests: () => [...state.dependencyRequests],
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const port = Number(process.argv[2] ?? '5799')
  const mock = await startMock({ port })
  console.log(`mock qinglong listening on ${mock.baseUrl} (client_id=${CLIENT_ID}, client_secret=${CLIENT_SECRET})`)
}
