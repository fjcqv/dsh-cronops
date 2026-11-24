/**
 * A third panel product, written as a test fixture to prove the extensibility
 * claim: mounting a new product is **one adapter file plus one registerAdapter
 * call** — `lib/engine.js`, `lib/routes.js`, `lib/tools.js`, `client.js` and the
 * selftest harness itself are untouched.
 *
 * The product is fictional ("Acme Panel") and deliberately unlike both shipped
 * adapters: prefix `/v2`, a JSON login handshake with a millisecond TTL, an
 * always-200 envelope where `ok:false` carries `{problem:{code,message}}`, and
 * `vars`/`jobs` instead of `envs`/`crons`.
 */

import { PanelDriver } from '../../lib/panels/driver.js'

/** Wire prefix. */
const PREFIX = '/v2'
/** Acme accepts at most 5 ids per action call. */
const BATCH_LIMIT = 5

/** Extract `{ code, message }` from a failure envelope. */
function problemOf(body) {
  const problem = typeof body === 'object' && body !== null ? body.problem : undefined
  if (typeof problem !== 'object' || problem === null) return {}
  return {
    code: typeof problem.code === 'string' ? problem.code : undefined,
    message: typeof problem.message === 'string' && problem.message.trim() !== '' ? problem.message.trim() : undefined,
  }
}

/** The Acme adapter. */
export class Panel3Driver extends PanelDriver {
  constructor(store, options = {}) {
    super(store, { ...options, kind: 'panel3' })
  }

  prefixFor() {
    return PREFIX
  }

  authRequest(entry) {
    return {
      url: `${entry.baseUrl}${PREFIX}/login`,
      method: 'POST',
      body: { key: entry.auth.appKey, secret: entry.auth.appSecret },
      label: 'Acme 登录',
    }
  }

  readToken(body, response) {
    // login() receives what parseResponse normalized: `{ data: result }`.
    const result = body?.data
    if (typeof result !== 'object' || result === null || typeof result.session !== 'string' || result.session === '') {
      throw this.fail('Acme 的登录响应缺少 result.session', { status: response.status })
    }
    const ttl = typeof result.ttlMs === 'number' && result.ttlMs > 0 ? result.ttlMs : 900_000
    return { token: result.session, expiresAt: Date.now() + ttl }
  }

  parseResponse(response, label) {
    let body
    try {
      body = response.text === '' ? {} : JSON.parse(response.text)
    } catch {
      throw this.fail(`${label} 返回的不是 JSON`, { status: response.status, malformed: true })
    }
    // Acme always answers 200 and puts the verdict in the envelope; normalizing
    // it to `{ data }` lets every shared helper (data, probeScopes) work as is.
    if (body?.ok === true) return { data: body.result }
    const { code, message } = problemOf(body)
    throw this.fail(`${label}：${message ?? 'Acme 拒绝了该请求'}`, {
      status: response.status,
      code,
      needsAuth: code === 'UNAUTH' || response.status === 401,
      forbidden: code === 'FORBIDDEN' || response.status === 403,
    })
  }

  probeTargets() {
    return {
      vars: { path: '/vars' },
      jobs: { path: '/jobs' },
    }
  }

  connect(alias) {
    return this.anonymous(alias, '/version').then(body => (typeof body?.data?.version === 'string' ? body.data.version : undefined))
  }

  cheapestRead() {
    return { path: '/vars' }
  }

  forbiddenMessage(error) {
    return `会话有效，但该账号缺少 vars 权限：${error.message}`
  }

  // ------------------------------------------------------------ resources
  // `vars` play the role of environment variables, `jobs` of scheduled tasks.

  async envsList(alias, keyword) {
    const rows = await this.data(alias, { path: '/vars' })
    const list = Array.isArray(rows) ? rows : []
    const needle = typeof keyword === 'string' ? keyword.toLowerCase() : ''
    return list
      .filter(row => needle === '' || String(row.key).toLowerCase().includes(needle))
      .map(row => ({
        id: row.uid,
        name: row.key,
        value: row.val,
        remarks: row.note,
        status: row.active === false ? 1 : 0,
        position: 0,
      }))
  }

  async envsCreate(alias, rows) {
    const created = []
    for (const row of rows) {
      const body = await this.data(alias, { method: 'POST', path: '/vars', body: { key: row.name, val: row.value, note: row.remarks ?? '', active: row.status !== 1 } })
      created.push(body?.uid)
    }
    return created
  }

  async envsUpdate(alias, row) {
    await this.data(alias, {
      method: 'PATCH',
      path: `/vars/${row.id}`,
      body: {
        ...(row.name === undefined ? {} : { key: row.name }),
        ...(row.value === undefined ? {} : { val: row.value }),
        ...(row.remarks === undefined ? {} : { note: row.remarks }),
        ...(row.status === undefined ? {} : { active: row.status !== 1 }),
      },
    })
    return { ok: true }
  }

  async envsRemove(alias, ids) {
    for (const id of ids) await this.data(alias, { method: 'DELETE', path: `/vars/${id}` })
    return { ok: true }
  }

  async cronsList(alias) {
    const rows = await this.data(alias, { path: '/jobs' })
    const list = Array.isArray(rows) ? rows : []
    return list.map(row => ({
      id: row.uid,
      name: row.title,
      command: row.cmd,
      schedule: row.when,
      status: row.active === false ? 1 : 0,
      lastRunAt: row.lastRunAt ?? undefined,
    }))
  }

  async cronsAction(alias, request) {
    const ids = Array.isArray(request.ids) ? request.ids : []
    const chunks = []
    for (let index = 0; index < ids.length; index += BATCH_LIMIT) chunks.push(ids.slice(index, index + BATCH_LIMIT))
    for (const chunk of chunks) {
      await this.data(alias, { method: 'POST', path: '/jobs/actions', body: { action: request.action, uids: chunk } })
    }
    return { ok: true, count: ids.length }
  }
}

/** Registerable metadata (the "one line" the registry needs). */
export const PANEL3_META = {
  kind: 'panel3',
  label: 'Acme',
  errorLabel: 'Acme 面板',
  credentialFields: [
    { key: 'appKey', i18nKey: 'panels.field.clientId', secret: false },
    { key: 'appSecret', i18nKey: 'panels.field.clientSecret', secret: true },
  ],
  scopeOrder: ['vars', 'jobs'],
  ignoredScopes: [],
  supportsWorkDir: false,
}
