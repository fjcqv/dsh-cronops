/**
 * The /api/dsh-cronops route family: panel connection CRUD, a connection
 * test, environment-variable and scheduled-task management, plus one generic
 * OpenAPI bridge for the agent surface.
 *
 * Every route carries the loopback trust fence (see lib/loopback.js): these
 * endpoints drive a remote panel with stored credentials. Failures are mapped
 * to one JSON body shape `{ error, code? }` so the browser half renders the
 * panel's own message instead of a generic HTTP failure.
 */

import { asJsonObject, readJsonBody, writeJson } from './http.js'
import { isForwardedLoopbackRequest, isLoopbackRequest } from './loopback.js'
import {
  ALLOWED_PATH_SEGMENTS,
  DAIDAI_ALLOWED_PATH_SEGMENTS,
  DAIDAI_DENIED_PATH_SEGMENTS,
  DENIED_PATH_SEGMENTS,
  QL_API,
} from './protocol.js'
import { QinglongError, errorMessage } from './qinglong.js'

/** Environment-variable name grammar enforced by the panel. */
const ENV_NAME_RE = /^[a-zA-Z_][0-9a-zA-Z_]*$/

/** Accepted HTTP verbs for the generic bridge. */
const GENERIC_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

/** Coerce an id list from either a single number or an array of numbers. */
function idList(value, field) {
  const raw = Array.isArray(value) ? value : [value]
  const ids = raw.map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0)
  if (ids.length === 0) throw new QinglongError(`${field} 需要至少一个任务/变量 ID`)
  return ids
}

/** Require a non-empty string field. */
function str(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new QinglongError(`${field} 不能为空`)
  return value.trim()
}

/** Map one thrown value onto an HTTP status plus the shared error body. */
function fail(res, error) {
  const message = errorMessage(error)
  const code = error instanceof QinglongError ? error.code : undefined
  const status = error instanceof QinglongError && typeof error.status === 'number' && error.status >= 400
    ? error.status
    : code === 404 ? 404
      : code === 401 ? 401
        : code === 403 ? 403
          : 400
  writeJson(res, status, {
    error: message,
    ...(typeof code === 'number' ? { code } : {}),
    ...(error instanceof QinglongError && error.needsAuth === true ? { needsAuth: true } : {}),
  })
}

/**
 * Build the route family.
 * @param deps - store, engine, and the proxy-fence switch.
 * @returns the routes to register on the web server.
 */
export function makeRoutes(deps) {
  const { store, engine } = deps
  const allowProxied = () => deps.allowProxiedRequests?.() === true

  /** Fence + method check. */
  const admit = (req, res, methods) => {
    const trusted = allowProxied() ? isForwardedLoopbackRequest(req) : isLoopbackRequest(req)
    if (!trusted) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (!methods.includes(req.method ?? 'GET')) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** Read a JSON object body or answer 400. */
  const body = async (req, res) => {
    const parsed = await readJsonBody(req, { objectOnly: true })
    const object = asJsonObject(parsed)
    if (object === undefined) {
      writeJson(res, 400, { error: 'invalid JSON body: expected an object' })
      return undefined
    }
    return object
  }

  const url = req => new URL(req.url ?? '/', 'http://localhost')

  return [
    // -------------------------------------------------------------- panels
    {
      kind: 'exact',
      path: QL_API.panels,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET') {
            writeJson(res, 200, {
              panels: store.list().map(entry => store.summarize(entry)),
              ...(store.defaultAlias() === undefined ? {} : { defaultPanel: store.defaultAlias() }),
            })
            return
          }
          if (method === 'POST') {
            const payload = await body(req, res)
            if (payload === undefined) return
            const entry = store.create(payload)
            writeJson(res, 201, { panel: store.summarize(entry) })
            return
          }
          const alias = url(req).searchParams.get('alias')
          if (alias === null || alias === '') {
            writeJson(res, 400, { error: 'alias query parameter is required' })
            return
          }
          if (method === 'PATCH') {
            const payload = await body(req, res)
            if (payload === undefined) return
            const entry = store.update(alias, payload)
            // A changed address or credential invalidates any cached token and
            // must never let a later call run against the old panel identity.
            if (['kind', 'baseUrl', 'auth', 'insecureTls', 'timeoutMs'].some(key => payload[key] !== undefined)) {
              engine.dropAlias(alias)
            }
            writeJson(res, 200, { panel: store.summarize(entry) })
            return
          }
          engine.dropAlias(alias)
          store.delete(alias)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.panelsDefault,
      handler: async (req, res) => {
        if (!admit(req, res, ['POST'])) return
        const payload = await body(req, res)
        if (payload === undefined) return
        try {
          store.setDefault(str(payload.alias, 'alias'))
          writeJson(res, 200, { defaultPanel: store.defaultAlias() })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.test,
      handler: async (req, res) => {
        if (!admit(req, res, ['POST'])) return
        const payload = await body(req, res)
        if (payload === undefined) return
        try {
          writeJson(res, 200, {
            result: await engine.test(typeof payload.alias === 'string' ? payload.alias : undefined, {
              // An explicit "test" click re-probes scopes; the automatic probe
              // after switching panels reuses the cached map.
              refresh: payload.refresh === true,
            }),
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    // ---------------------------------------------------------------- envs
    {
      kind: 'exact',
      path: QL_API.envs,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET') {
            const params = url(req).searchParams
            const alias = params.get('alias') ?? undefined
            const envs = await engine.envsList(alias, params.get('searchValue') ?? undefined)
            writeJson(res, 200, { envs })
            return
          }
          const payload = await body(req, res)
          if (payload === undefined) return
          const alias = typeof payload.alias === 'string' ? payload.alias : undefined
          if (method === 'POST') {
            const list = Array.isArray(payload.envs) ? payload.envs : [payload.env]
            if (list.length === 0 || list.some(item => typeof item !== 'object' || item === null)) {
              writeJson(res, 400, { error: 'envs must be a non-empty array of {name,value}' })
              return
            }
            const envs = list.map(item => {
              const name = str(item.name, '环境变量名称')
              if (!ENV_NAME_RE.test(name)) throw new QinglongError('变量名必须以字母或下划线开头，只能包含字母、数字和下划线')
              const row = { name, value: typeof item.value === 'string' ? item.value : str(item.value, '环境变量值') }
              if (typeof item.remarks === 'string') row.remarks = item.remarks
              if (Array.isArray(item.labels)) row.labels = item.labels.filter(label => typeof label === 'string' && label.trim() !== '')
              return row
            })
            writeJson(res, 200, { result: await engine.envsCreate(alias, envs) })
            return
          }
          if (method === 'PATCH') {
            const env = asJsonObject(payload.env)
            if (env === undefined) {
              writeJson(res, 400, { error: 'env object is required' })
              return
            }
            const id = Number(env.id)
            if (!Number.isInteger(id) || id <= 0) {
              writeJson(res, 400, { error: 'env.id is required' })
              return
            }
            const patch = asJsonObject(env.patch) ?? {}
            if (typeof patch.name === 'string' && !ENV_NAME_RE.test(patch.name)) {
              writeJson(res, 400, { error: '变量名必须以字母或下划线开头，只能包含字母、数字和下划线' })
              return
            }
            writeJson(res, 200, { result: await engine.envsUpdate(alias, id, patch) })
            return
          }
          writeJson(res, 200, { result: await engine.envsRemove(alias, idList(payload.ids, 'ids')) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.envsAction,
      handler: async (req, res) => {
        if (!admit(req, res, ['POST'])) return
        const payload = await body(req, res)
        if (payload === undefined) return
        try {
          const alias = typeof payload.alias === 'string' ? payload.alias : undefined
          const action = str(payload.action, 'action')
          const ids = idList(payload.ids, 'ids')
          writeJson(res, 200, { result: await engine.envsToggle(alias, action, ids) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    // --------------------------------------------------------------- crons
    {
      kind: 'exact',
      path: QL_API.crons,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET') {
            const params = url(req).searchParams
            const query = {}
            for (const key of ['searchValue', 'page', 'size', 'status', 'labels', 'sorts']) {
              const value = params.get(key)
              if (value !== null && value !== '') query[key] = value
            }
            const result = await engine.cronsList(params.get('alias') ?? undefined, query)
            writeJson(res, 200, result)
            return
          }
          const payload = await body(req, res)
          if (payload === undefined) return
          const alias = typeof payload.alias === 'string' ? payload.alias : undefined
          if (method === 'POST') {
            const cron = asJsonObject(payload.cron)
            if (cron === undefined) {
              writeJson(res, 400, { error: 'cron object is required' })
              return
            }
            const row = {
              ...cron,
              name: typeof cron.name === 'string' ? cron.name : '',
              command: str(cron.command, '任务命令'),
              schedule: str(cron.schedule, '定时规则'),
              labels: Array.isArray(cron.labels) ? cron.labels.filter(label => typeof label === 'string' && label.trim() !== '') : [],
            }
            writeJson(res, 200, { result: await engine.cronsCreate(alias, row) })
            return
          }
          if (method === 'PATCH') {
            const id = Number(payload.id)
            if (!Number.isInteger(id) || id <= 0) {
              writeJson(res, 400, { error: 'id is required' })
              return
            }
            const patch = asJsonObject(payload.patch) ?? {}
            writeJson(res, 200, { result: await engine.cronsUpdate(alias, id, patch) })
            return
          }
          writeJson(res, 200, { result: await engine.cronsRemove(alias, idList(payload.ids, 'ids')) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.cronsItem,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET'])) return
        try {
          const params = url(req).searchParams
          const id = Number(params.get('id'))
          if (!Number.isInteger(id) || id <= 0) {
            writeJson(res, 400, { error: 'id query parameter is required' })
            return
          }
          writeJson(res, 200, { cron: await engine.cronsGet(params.get('alias') ?? undefined, id) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.cronsAction,
      handler: async (req, res) => {
        if (!admit(req, res, ['POST'])) return
        const payload = await body(req, res)
        if (payload === undefined) return
        try {
          const alias = typeof payload.alias === 'string' ? payload.alias : undefined
          const action = str(payload.action, 'action')
          writeJson(res, 200, { result: await engine.cronsAction(alias, action, idList(payload.ids, 'ids')) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.cronsLog,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET'])) return
        try {
          const params = url(req).searchParams
          const id = Number(params.get('id'))
          if (!Number.isInteger(id) || id <= 0) {
            writeJson(res, 400, { error: 'id query parameter is required' })
            return
          }
          const query = {}
          for (const key of ['offset', 'limit', 'tail', 't', 'triggerId', 'instanceId', 'cursor']) {
            const value = params.get(key)
            if (value !== null && value !== '') query[key] = value
          }
          const envelope = await engine.cronsLog(params.get('alias') ?? undefined, id, query)
          writeJson(res, 200, {
            content: typeof envelope.data === 'string' ? envelope.data : '',
            logStatus: envelope.logStatus,
            offset: envelope.offset,
            nextOffset: envelope.nextOffset,
            total: envelope.total,
            truncated: envelope.truncated,
          })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: QL_API.cronsPreview,
      handler: async (req, res) => {
        if (!admit(req, res, ['GET'])) return
        try {
          const params = url(req).searchParams
          const schedule = str(params.get('schedule'), 'schedule')
          writeJson(res, 200, { preview: await engine.cronsPreview(params.get('alias') ?? undefined, schedule) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    // ----------------------------------------------------- generic bridge
    {
      kind: 'exact',
      path: QL_API.request,
      handler: async (req, res) => {
        if (!admit(req, res, ['POST'])) return
        const payload = await body(req, res)
        if (payload === undefined) return
        try {
          const method = str(payload.method, 'method').toUpperCase()
          if (!GENERIC_METHODS.includes(method)) {
            writeJson(res, 400, { error: `method must be one of ${GENERIC_METHODS.join(', ')}` })
            return
          }
          const path = str(payload.path, 'path')
          const segments = path.split('/').filter(segment => segment !== '')
          if (!path.startsWith('/') || segments.length === 0) {
            writeJson(res, 400, { error: 'path must start with "/" and name an OpenAPI resource, for example /envs' })
            return
          }
          const first = segments[0].toLowerCase() === 'open'
            ? (segments[1] ?? '').toLowerCase()
            : segments[0].toLowerCase()
          const alias = typeof payload.alias === 'string' ? payload.alias : undefined
          const kind = (() => {
            const target = typeof alias === 'string' && alias !== '' ? alias : store.defaultAlias()
            const entry = target === undefined ? undefined : store.find(target)
            return entry?.kind ?? 'qinglong'
          })()
          const allowed = kind === 'daidai' ? DAIDAI_ALLOWED_PATH_SEGMENTS : ALLOWED_PATH_SEGMENTS
          const denied = kind === 'daidai' ? DAIDAI_DENIED_PATH_SEGMENTS : DENIED_PATH_SEGMENTS
          if (denied.includes(first)) {
            writeJson(res, 403, { error: `拒绝访问 /${first}：该资源涉及凭据、账号或备份，请直接在面板操作` })
            return
          }
          if (!allowed.includes(first)) {
            writeJson(res, 400, { error: `不支持的资源 /${first}；可用：${allowed.join(', ')}` })
            return
          }
          const query = asJsonObject(payload.query)
          const envelope = await engine.raw(alias, {
            method,
            path: path.replace(/^\/open/, ''),
            ...(query === undefined ? {} : { query }),
            ...(payload.body === undefined ? {} : { body: payload.body }),
          })
          writeJson(res, 200, { result: envelope })
        } catch (error) {
          fail(res, error)
        }
      },
    },
  ]
}
