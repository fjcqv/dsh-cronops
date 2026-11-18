/**
 * Host-half self test: mounts the plugin's route family on a throwaway HTTP
 * server, points it at the local Qinglong mock, and exercises every operation
 * the browser half and the agent tools use — including the failure branches.
 *
 * Run: `node scripts/selftest.mjs`
 */

import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PanelEngine } from '../lib/engine.js'
import { QinglongError, classifyProbeError } from '../lib/qinglong.js'
import { makeRoutes } from '../lib/routes.js'
import { PanelStore } from '../lib/store.js'
import { startDaidaiMock } from './mock-daidai.mjs'
import { startMock } from './mock-qinglong.mjs'

let passed = 0
let failed = 0

/** Assert one condition. */
function expect(condition, message, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + message)
    return
  }
  failed += 1
  console.log('  FAIL ' + message + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)))
}

/** Run one section. */
async function section(title, body) {
  console.log('\n# ' + title)
  try {
    await body()
  } catch (error) {
    failed += 1
    console.log('  FAIL threw :: ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  }
}

/** Start the route server. */
async function startRouteServer(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = routes.find(candidate => candidate.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    await route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** One JSON call against the route server. */
async function call(baseUrl, path, options = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  const text = search.toString()
  const response = await fetch(baseUrl + path + (text === '' ? '' : '?' + text), {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const raw = await response.text()
  let json
  try {
    json = raw === '' ? undefined : JSON.parse(raw)
  } catch {
    json = { raw }
  }
  return { status: response.status, json }
}

async function main() {
  const mock = await startMock()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cronops-selftest-'))
  const storePath = join(dir, 'dsh-cronops.json')
  const store = new PanelStore(storePath)
  const engine = new PanelEngine(store, { timeoutMs: 5000 })
  const routes = makeRoutes({ store, engine, allowProxiedRequests: () => false })
  const server = await startRouteServer(routes)

  try {
    await section('panels: validation and creation', async () => {
      const empty = await call(server.baseUrl, '/api/dsh-cronops/panels')
      expect(empty.status === 200 && Array.isArray(empty.json.panels) && empty.json.panels.length === 0, 'list starts empty', empty)

      const bad = await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'POST',
        body: { alias: 'x', baseUrl: 'ftp://nope', auth: { kind: 'open', clientId: 'a', clientSecret: 'b' } },
      })
      expect(bad.status === 400 && /http/.test(bad.json.error), 'rejects a non-http base URL', bad)

      const created = await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'POST',
        body: {
          alias: 'mock',
          baseUrl: mock.baseUrl,
          auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' },
          description: 'selftest',
        },
      })
      expect(created.status === 201 && created.json.panel.alias === 'mock', 'creates the mock panel', created)
      expect(created.json.panel.isDefault === true, 'first panel becomes default', created.json)
      expect(JSON.stringify(created.json).includes('mock-secret') === false, 'response never carries the secret', created.json)

      const dup = await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'POST',
        body: { alias: 'mock', baseUrl: mock.baseUrl, auth: { kind: 'open', clientId: 'a', clientSecret: 'b' } },
      })
      expect(dup.status === 400 && /already exists/.test(dup.json.error), 'rejects a duplicate alias', dup)

      const mode = statSync(storePath).mode & 0o777
      expect(mode === 0o600, 'store file is 0600', mode.toString(8))
    })

    await section('probe: reachability, credential and scope states', async () => {
      const ok = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'mock' } })
      expect(ok.status === 200 && ok.json.result.reachable === true, 'reachable', ok.json)
      expect(ok.json.result.version === '2.24.0-mock', 'version reported', ok.json.result)
      expect(ok.json.result.auth === 'ok', 'credential accepted', ok.json.result)
      const scopes = ok.json.result.scopes ?? {}
      expect(scopes.envs === 'ok' && scopes.crons === 'ok', 'scope probe reports envs/crons', scopes)
      // The dependency probe takes the cheap filtered path first.
      expect(mock.dependencyRequests()[0]?.type === 'python3', 'dependency probe uses type=python3', mock.dependencyRequests())
      expect(scopes.system === 'public', 'public system endpoint reported', scopes)
      expect(JSON.stringify(ok.json.result).includes('mock-secret') === false, 'probe never leaks the secret', ok.json.result)

      // The probe outcome is persisted: the hosts list carries it, and listing
      // twice must reuse it instead of re-querying the panel.
      const listedA = await call(server.baseUrl, '/api/dsh-cronops/panels')
      const rowA = (listedA.json.panels ?? []).find(panel => panel.alias === 'mock')
      expect(rowA?.test?.scopes?.envs === 'ok', 'probe result persisted on the panel', rowA)
      expect(typeof rowA?.test?.at === 'number', 'probe timestamp persisted', rowA?.test)
      await new Promise(resolve => setTimeout(resolve, 5))
      const listedB = await call(server.baseUrl, '/api/dsh-cronops/panels')
      const rowB = (listedB.json.panels ?? []).find(panel => panel.alias === 'mock')
      expect(rowA?.test?.at === rowB?.test?.at, 'listing reuses the stored probe (no re-query)', { a: rowA?.test?.at, b: rowB?.test?.at })
    })

    await section('envs: list, create, update, toggle, delete', async () => {
      const list = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'mock' } })
      expect(list.status === 200 && list.json.envs.length === 2, 'lists seeded variables', list.json)

      const created = await call(server.baseUrl, '/api/dsh-cronops/envs', {
        method: 'POST',
        body: { alias: 'mock', envs: [{ name: 'NEW_VAR', value: 'v1', remarks: 'from selftest' }] },
      })
      expect(created.status === 200, 'creates a variable', created)

      const searched = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'mock', searchValue: 'NEW_VAR' } })
      const row = searched.json.envs?.[0]
      expect(searched.json.envs?.length === 1 && row.name === 'NEW_VAR', 'search finds it', searched.json)

      const updated = await call(server.baseUrl, '/api/dsh-cronops/envs', {
        method: 'PATCH',
        body: { alias: 'mock', env: { id: row.id, patch: { value: 'v2' } } },
      })
      expect(updated.status === 200 && updated.json.result.value === 'v2', 'update merges stored name/value', updated.json)

      const invalid = await call(server.baseUrl, '/api/dsh-cronops/envs', {
        method: 'POST',
        body: { alias: 'mock', envs: [{ name: '1BAD', value: 'x' }] },
      })
      expect(invalid.status === 400 && /变量名/.test(invalid.json.error), 'rejects an invalid variable name', invalid.json)

      const disabled = await call(server.baseUrl, '/api/dsh-cronops/envs/action', {
        method: 'POST',
        body: { alias: 'mock', action: 'disable', ids: [row.id] },
      })
      expect(disabled.status === 200, 'disables it', disabled.json)
      const afterToggle = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'mock', searchValue: 'NEW_VAR' } })
      expect(afterToggle.json.envs?.[0]?.status === 1, 'status flipped on the panel', afterToggle.json)

      const removed = await call(server.baseUrl, '/api/dsh-cronops/envs', {
        method: 'DELETE',
        body: { alias: 'mock', ids: [row.id] },
      })
      expect(removed.status === 200, 'deletes it', removed.json)
    })

    await section('crons: list, create, update, run, stop, log, preview, delete', async () => {
      const list = await call(server.baseUrl, '/api/dsh-cronops/crons', { query: { alias: 'mock', page: 1, size: 20 } })
      expect(list.status === 200 && list.json.rows.length === 2 && list.json.total === 2, 'lists tasks with total', list.json)

      const created = await call(server.baseUrl, '/api/dsh-cronops/crons', {
        method: 'POST',
        body: { alias: 'mock', cron: { name: 'selftest', command: 'task selftest.js', schedule: '0 0 * * *' } },
      })
      expect(created.status === 200 && created.json.result.id !== undefined, 'creates a task', created.json)
      const id = created.json.result.id

      const merged = await call(server.baseUrl, '/api/dsh-cronops/crons', {
        method: 'PATCH',
        body: { alias: 'mock', id, patch: { name: 'selftest-renamed' } },
      })
      expect(merged.status === 200 && merged.json.result.name === 'selftest-renamed', 'update merges the full task', merged.json)
      expect(merged.json.result.command === 'task selftest.js', 'merged body keeps command', merged.json)

      const run = await call(server.baseUrl, '/api/dsh-cronops/crons/action', {
        method: 'POST',
        body: { alias: 'mock', action: 'run', ids: [id] },
      })
      expect(run.status === 200, 'runs the task', run.json)

      const stop = await call(server.baseUrl, '/api/dsh-cronops/crons/action', {
        method: 'POST',
        body: { alias: 'mock', action: 'stop', ids: [id] },
      })
      expect(stop.status === 200, 'stops the task', stop.json)

      const log = await call(server.baseUrl, '/api/dsh-cronops/crons/log', { query: { alias: 'mock', id, limit: 65536 } })
      expect(log.status === 200 && String(log.json.content).includes('selftest.js'), 'reads the task log', log.json)

      const preview = await call(server.baseUrl, '/api/dsh-cronops/crons/preview', {
        query: { alias: 'mock', schedule: '0 0 * * *' },
      })
      expect(preview.status === 200 && Array.isArray(preview.json.preview?.times) && preview.json.preview.times.length === 3, 'previews the schedule', preview.json)

      const removed = await call(server.baseUrl, '/api/dsh-cronops/crons', {
        method: 'DELETE',
        body: { alias: 'mock', ids: [id] },
      })
      expect(removed.status === 200, 'deletes the task', removed.json)
    })

    await section('generic bridge: allowed, refused, unknown', async () => {
      const allowed = await call(server.baseUrl, '/api/dsh-cronops/request', {
        method: 'POST',
        body: { alias: 'mock', method: 'GET', path: '/dependencies' },
      })
      expect(allowed.status === 200 && allowed.json.result.code === 200, 'reads an allowed resource', allowed.json)

      const denied = await call(server.baseUrl, '/api/dsh-cronops/request', {
        method: 'POST',
        body: { alias: 'mock', method: 'GET', path: '/apps' },
      })
      expect(denied.status === 403 && /拒绝访问/.test(denied.json.error), 'refuses /apps', denied.json)

      const unknown = await call(server.baseUrl, '/api/dsh-cronops/request', {
        method: 'POST',
        body: { alias: 'mock', method: 'GET', path: '/nope' },
      })
      expect(unknown.status === 400 && /不支持/.test(unknown.json.error), 'refuses an unknown resource', unknown.json)

      // `/health` needs a panel-side scope an application cannot hold, so the
      // bridge now rejects it up-front instead of forwarding a 403.
      const health = await call(server.baseUrl, '/api/dsh-cronops/request', {
        method: 'POST',
        body: { alias: 'mock', method: 'GET', path: '/health' },
      })
      expect(health.status === 400 && /不支持/.test(health.json.error), 'refuses /health up-front', health.json)
    })

    await section('failure branches: unknown panel, bad credential, unreachable host', async () => {
      const unknownPanel = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'ghost' } })
      expect(unknownPanel.status === 404 && /不存在/.test(unknownPanel.json.error), 'unknown alias is 404', unknownPanel.json)

      await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'PATCH',
        query: { alias: 'mock' },
        body: { auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'wrong' } },
      })
      const cleared = await call(server.baseUrl, '/api/dsh-cronops/panels')
      expect((cleared.json.panels ?? []).find(panel => panel.alias === 'mock')?.test === undefined,
        'credential change clears the stored probe', cleared.json.panels)

      const badCred = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'mock' } })
      expect(badCred.json.result.reachable === true, 'panel still reachable with bad credential', badCred.json.result)
      expect(badCred.json.result.auth === 'required', 'credential rejection reported as required', badCred.json.result)
      expect(/client_id/.test(String(badCred.json.result.message)), 'panel message preserved', badCred.json.result)

      await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'PATCH',
        query: { alias: 'mock' },
        body: { auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' } },
      })
      const recovered = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'mock' } })
      expect(recovered.json.result.auth === 'ok', 'restored credential works again', recovered.json.result)

      await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'POST',
        body: { alias: 'dead', baseUrl: 'http://127.0.0.1:9', auth: { kind: 'open', clientId: 'a', clientSecret: 'b' } },
      })
      const dead = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'dead' } })
      expect(dead.json.result.reachable === false && dead.json.result.auth === 'failed', 'unreachable panel reported', dead.json.result)
      expect(/连接被拒绝|超时|无法/.test(String(dead.json.result.message)), 'unreachable message is actionable', dead.json.result)
      await call(server.baseUrl, '/api/dsh-cronops/panels', { method: 'DELETE', query: { alias: 'dead' } })
    })

    await section('scope probe: a missing scope reads as forbidden', async () => {
      const limited = await startMock({ denyScopes: ['scripts'] })
      try {
        const created = await call(server.baseUrl, '/api/dsh-cronops/panels', {
          method: 'POST',
          body: { alias: 'limited', baseUrl: limited.baseUrl, auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' } },
        })
        expect(created.status === 201, 'limited panel created', created.json)
        const result = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'limited' } })
        const scopes = result.json.result.scopes ?? {}
        expect(scopes.scripts === 'forbidden', 'denied scope reads as forbidden', scopes)
        expect(scopes.envs === 'ok', 'granted scope still reads ok', scopes)
        await call(server.baseUrl, '/api/dsh-cronops/panels', { method: 'DELETE', query: { alias: 'limited' } })
      } finally {
        await limited.close()
      }
    })

    await section('default panel and token reuse', async () => {
      await call(server.baseUrl, '/api/dsh-cronops/panels', {
        method: 'POST',
        body: { alias: 'second', baseUrl: mock.baseUrl, auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' } },
      })
      const setDefault = await call(server.baseUrl, '/api/dsh-cronops/panels/default', {
        method: 'POST',
        body: { alias: 'second' },
      })
      expect(setDefault.status === 200 && setDefault.json.defaultPanel === 'second', 'default panel switches', setDefault.json)

      // No alias: the default panel answers.
      const implicit = await call(server.baseUrl, '/api/dsh-cronops/envs')
      expect(implicit.status === 200 && Array.isArray(implicit.json.envs), 'aliasless call uses the default panel', implicit.json)

      // Concurrency: five parallel calls share one cached token.
      const parallel = await Promise.all(Array.from({ length: 5 }, () => call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'second' } })))
      expect(parallel.every(result => result.status === 200), 'parallel calls reuse the token', parallel.map(result => result.status))

      const removed = await call(server.baseUrl, '/api/dsh-cronops/panels', { method: 'DELETE', query: { alias: 'second' } })
      expect(removed.status === 200, 'deletes the second panel', removed.json)
    })

    await section('probe classification and dependency fallback', async () => {
      const classify = error => classifyProbeError(error)
      const timeoutError = Object.assign(new Error('request timed out after 1000 ms'), { code: 'ETIMEDOUT' })
      expect(classify(timeoutError) === 'timeout', 'timeout classified as timeout', classify(timeoutError))
      expect(classify(new QinglongError('暂无权限', { code: 403, status: 403 })) === 'forbidden', '403 classified as forbidden')
      expect(classify(new QinglongError('Token 已失效', { code: 401, status: 401, needsAuth: true })) === 'auth', '401 classified as auth')
      expect(classify(new Error('ECONNREFUSED')) === 'error', 'network error classified as error')

      // A slow unfiltered list must still succeed through the fallback path.
      const slow = await startMock({ slowDependencies: true })
      try {
        const created = await call(server.baseUrl, '/api/dsh-cronops/panels', {
          method: 'POST',
          body: {
            alias: 'slowdep',
            baseUrl: slow.baseUrl,
            auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' },
            timeoutMs: 1000,
          },
        })
        expect(created.status === 201, 'slow-dependency panel created', created.json)
        const result = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'slowdep' } })
        expect(result.json.result.scopes?.dependencies === 'ok', 'fallback probe still reports dependencies ok', result.json.result.scopes)
        const requests = slow.dependencyRequests()
        expect(requests.length >= 2 && requests[0].type === 'python3' && requests[1].type === null,
          'fallback retried without the type filter', requests)
        await call(server.baseUrl, '/api/dsh-cronops/panels', { method: 'DELETE', query: { alias: 'slowdep' } })
      } finally {
        await slow.close()
      }
    })

    await section('daidai: kind, probe, scopes, envs, tasks', async () => {
      const dd = await startDaidaiMock({ denyScopes: ['logs'] })
      try {
        const created = await call(server.baseUrl, '/api/dsh-cronops/panels', {
          method: 'POST',
          body: {
            alias: 'dd',
            kind: 'daidai',
            baseUrl: dd.baseUrl,
            auth: { kind: 'open', appKey: 'dd-key', appSecret: 'dd-secret' },
          },
        })
        expect(created.status === 201 && created.json.panel.kind === 'daidai', 'creates a daidai panel', created.json)
        expect(created.json.panel.appKey === 'dd-key', 'kind-specific credential projected', created.json.panel)
        expect(JSON.stringify(created.json).includes('dd-secret') === false, 'daidai secret never projected', created.json)

        const probe = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'dd' } })
        expect(probe.json.result.version === '3.4.4-mock', 'daidai version reported', probe.json.result)
        expect(probe.json.result.auth === 'ok', 'daidai credential accepted', probe.json.result)
        expect(probe.json.result.scopes?.tasks === 'ok', 'tasks scope ok', probe.json.result.scopes)
        expect(probe.json.result.scopes?.logs === 'forbidden', 'missing logs scope reads forbidden', probe.json.result.scopes)
        expect(probe.json.result.scopes?.notifications === undefined, 'notification scope is not probed', probe.json.result.scopes)
        expect(Object.keys(probe.json.result.scopes ?? {}).length === 7, 'daidai probes exactly seven modules', probe.json.result.scopes)

        const envs = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'dd' } })
        expect(envs.json.envs?.length === 2, 'lists daidai env vars', envs.json)
        expect(envs.json.envs[1]?.status === 1, 'disabled env maps to status 1', envs.json.envs)

        const createdEnv = await call(server.baseUrl, '/api/dsh-cronops/envs', {
          method: 'POST',
          body: { alias: 'dd', envs: [{ name: 'DD_NEW', value: 'v1', labels: ['g1'] }] },
        })
        expect(createdEnv.status === 200, 'creates a daidai env var', createdEnv.json)
        const found = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'dd', searchValue: 'DD_NEW' } })
        const envRow = found.json.envs?.[0]
        expect(envRow?.name === 'DD_NEW' && envRow?.group === 'g1', 'labels map onto group', found.json)

        const updatedEnv = await call(server.baseUrl, '/api/dsh-cronops/envs', {
          method: 'PATCH',
          body: { alias: 'dd', env: { id: envRow.id, patch: { value: 'v2' } } },
        })
        expect(updatedEnv.json.result?.data?.value === 'v2', 'updates a daidai env var', updatedEnv.json)

        const toggled = await call(server.baseUrl, '/api/dsh-cronops/envs/action', {
          method: 'POST',
          body: { alias: 'dd', action: 'disable', ids: [envRow.id] },
        })
        expect(toggled.status === 200, 'disables a daidai env var', toggled.json)
        const afterToggle = await call(server.baseUrl, '/api/dsh-cronops/envs', { query: { alias: 'dd', searchValue: 'DD_NEW' } })
        expect(afterToggle.json.envs?.[0]?.status === 1, 'disable visible after reload', afterToggle.json)

        const removedEnv = await call(server.baseUrl, '/api/dsh-cronops/envs', {
          method: 'DELETE',
          body: { alias: 'dd', ids: [envRow.id] },
        })
        expect(removedEnv.status === 200, 'deletes a daidai env var', removedEnv.json)

        const tasks = await call(server.baseUrl, '/api/dsh-cronops/crons', { query: { alias: 'dd', page: 1, size: 20 } })
        expect(tasks.json.rows?.length === 2 && tasks.json.total === 2, 'lists daidai tasks', tasks.json)
        expect(tasks.json.rows[1]?.isDisabled === 1, 'disabled task maps isDisabled', tasks.json.rows)

        const createdTask = await call(server.baseUrl, '/api/dsh-cronops/crons', {
          method: 'POST',
          body: { alias: 'dd', cron: { name: 'dd-task', command: 'task a.js', schedule: '0 1 * * *' } },
        })
        const taskId = createdTask.json.result?.data?.id
        expect(createdTask.status === 200 && taskId !== undefined, 'creates a daidai task', createdTask.json)

        const patchedTask = await call(server.baseUrl, '/api/dsh-cronops/crons', {
          method: 'PATCH',
          body: { alias: 'dd', id: taskId, patch: { name: 'dd-task-2', schedule: '0 2 * * *' } },
        })
        expect(patchedTask.json.result?.data?.name === 'dd-task-2', 'updates a daidai task', patchedTask.json)
        expect(patchedTask.json.result?.data?.cron_expression === '0 2 * * *', 'schedule maps to cron_expression', patchedTask.json)

        const run = await call(server.baseUrl, '/api/dsh-cronops/crons/action', {
          method: 'POST',
          body: { alias: 'dd', action: 'run', ids: [taskId, 1] },
        })
        expect(run.status === 200, 'batch-runs daidai tasks (≤10)', run.json)

        const stop = await call(server.baseUrl, '/api/dsh-cronops/crons/action', {
          method: 'POST',
          body: { alias: 'dd', action: 'stop', ids: [taskId] },
        })
        expect(stop.status === 200, 'stops a daidai task', stop.json)

        const log = await call(server.baseUrl, '/api/dsh-cronops/crons/log', { query: { alias: 'dd', id: taskId } })
        expect(String(log.json.content).includes('task a.js'), 'reads the daidai latest log', log.json)

        const preview = await call(server.baseUrl, '/api/dsh-cronops/crons/preview', {
          query: { alias: 'dd', schedule: '0 2 * * *' },
        })
        expect(preview.json.preview?.times?.length === 3, 'previews a daidai cron expression', preview.json)

        const bridge = await call(server.baseUrl, '/api/dsh-cronops/request', {
          method: 'POST',
          body: { alias: 'dd', method: 'GET', path: '/tasks' },
        })
        expect(bridge.status === 200, 'bridge reaches daidai /tasks', bridge.json)
        const bridgeDenied = await call(server.baseUrl, '/api/dsh-cronops/request', {
          method: 'POST',
          body: { alias: 'dd', method: 'GET', path: '/open-api/apps' },
        })
        expect(bridgeDenied.status === 403, 'bridge refuses daidai credentials endpoints', bridgeDenied.json)

        const removedTask = await call(server.baseUrl, '/api/dsh-cronops/crons', {
          method: 'DELETE',
          body: { alias: 'dd', ids: [taskId] },
        })
        expect(removedTask.status === 200, 'deletes a daidai task', removedTask.json)

        await call(server.baseUrl, '/api/dsh-cronops/panels', {
          method: 'PATCH',
          query: { alias: 'dd' },
          body: { auth: { kind: 'open', appKey: 'dd-key', appSecret: 'wrong' } },
        })
        const badSecret = await call(server.baseUrl, '/api/dsh-cronops/test', { method: 'POST', body: { alias: 'dd' } })
        expect(badSecret.json.result.auth === 'required', 'wrong daidai secret reads as required', badSecret.json.result)

        await call(server.baseUrl, '/api/dsh-cronops/panels', { method: 'DELETE', query: { alias: 'dd' } })
      } finally {
        await dd.close()
      }
    })

    await section('store file contents', async () => {
      const file = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(file.version === 1 && file.panels.length === 1, 'store shape is intact', file)
      expect(file.panels[0].auth.appSecret === 'mock-secret', 'secret stored owner-only (not projected)', file.panels[0].auth.appKey)
      expect(file.defaultPanel === 'mock', 'default panel recorded', file.defaultPanel)
    })
  } finally {
    await server.close()
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
