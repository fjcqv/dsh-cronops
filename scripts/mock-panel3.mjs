/**
 * A local mock of a *fictional* panel product ("Acme Panel"), used only by the
 * extensibility check in `scripts/selftest.mjs`.
 *
 * It is deliberately unlike both shipped products, so a passing test proves the
 * shared transport really is product-agnostic:
 *   - prefix `/v2`
 *   - `POST /v2/login {key,secret}` → `{ok:true,result:{session,ttlMs}}`
 *   - every response is HTTP 200; failure is `{ok:false,problem:{code,message}}`
 *   - resources are `vars` (env vars) and `jobs` (scheduled tasks)
 *
 * Run standalone: `node scripts/mock-panel3.mjs [port]`
 * Import:        `const mock = await startPanel3Mock({ port })`
 */

import http from 'node:http'

/** The credential the mock accepts. */
export const PANEL3_KEY = 'p3-key'
export const PANEL3_SECRET = 'p3-secret'
export const PANEL3_SESSION = 'p3-session-token'
export const PANEL3_VERSION = '9.9.9'

/** In-memory panel state. */
const state = {
  vars: [
    { uid: 1, key: 'P3_VAR', val: 'hello', note: 'seeded', active: true },
    { uid: 2, key: 'P3_OFF', val: 'off', note: '', active: false },
  ],
  jobs: [
    { uid: 1, title: 'demo', cmd: 'job demo.js', when: '0 3 * * *', active: true, lastRunAt: '2026-11-01T00:00:00Z' },
    { uid: 2, title: 'nightly', cmd: 'job nightly.js', when: '*/10 * * * *', active: false, lastRunAt: null },
  ],
  nextVar: 3,
  nextJob: 3,
}

/** One envelope response (always HTTP 200). */
function envelope(res, body) {
  const payload = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** A failure envelope. */
function problem(res, code, message) {
  envelope(res, { ok: false, problem: { code, message } })
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

/** Route one request. */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const auth = req.headers.authorization ?? ''
  const body = method === 'GET' ? undefined : await readBody(req)

  if (path === '/v2/version') {
    envelope(res, { ok: true, result: { version: PANEL3_VERSION } })
    return
  }
  if (path === '/v2/login' && method === 'POST') {
    if (body?.key !== PANEL3_KEY || body?.secret !== PANEL3_SECRET) {
      problem(res, 'BAD_CREDENTIALS', 'key/secret mismatch')
      return
    }
    envelope(res, { ok: true, result: { session: PANEL3_SESSION, ttlMs: 900_000 } })
    return
  }
  if (auth !== 'Bearer ' + PANEL3_SESSION) {
    problem(res, 'UNAUTH', 'session expired')
    return
  }

  if (path === '/v2/vars') {
    if (method === 'GET') {
      envelope(res, { ok: true, result: state.vars })
      return
    }
    if (method === 'POST') {
      if (typeof body?.key !== 'string' || body.key === '') {
        problem(res, 'BAD_REQUEST', 'key is required')
        return
      }
      const row = { uid: state.nextVar++, key: body.key, val: String(body.val ?? ''), note: String(body.note ?? ''), active: body.active !== false }
      state.vars.push(row)
      envelope(res, { ok: true, result: row })
      return
    }
  }

  const varItem = path.match(/^\/v2\/vars\/(\d+)$/)
  if (varItem !== null) {
    const uid = Number(varItem[1])
    const index = state.vars.findIndex(row => row.uid === uid)
    if (index < 0) {
      problem(res, 'NOT_FOUND', `var ${uid} not found`)
      return
    }
    if (method === 'PUT' || method === 'PATCH') {
      Object.assign(state.vars[index], body ?? {})
      envelope(res, { ok: true, result: state.vars[index] })
      return
    }
    if (method === 'DELETE') {
      state.vars.splice(index, 1)
      envelope(res, { ok: true, result: { uid } })
      return
    }
  }

  if (path === '/v2/jobs') {
    envelope(res, { ok: true, result: state.jobs })
    return
  }

  if (path === '/v2/jobs/actions' && method === 'POST') {
    const uids = Array.isArray(body?.uids) ? body.uids : []
    if (uids.length > 5) {
      problem(res, 'TOO_MANY', 'at most 5 uids per call')
      return
    }
    for (const uid of uids) {
      const row = state.jobs.find(job => job.uid === uid)
      if (row === undefined) {
        problem(res, 'NOT_FOUND', `job ${uid} not found`)
        return
      }
    }
    envelope(res, { ok: true, result: { action: body?.action ?? 'run', uids } })
    return
  }

  problem(res, 'NOT_FOUND', `no route for ${method} ${path}`)
}

/**
 * Start the mock.
 * @param options.port - 0 (default) picks a free port.
 * @returns baseUrl and close().
 */
export async function startPanel3Mock(options = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => problem(res, 'INTERNAL', String(error?.message ?? error)))
  })
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 0)
  const mock = await startPanel3Mock({ port })
  console.log(`panel3 mock on ${mock.baseUrl}`)
}
