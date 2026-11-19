/**
 * Tool-contract check: builds the four agent tools against the local mock and
 * validates every result against the tool's declared output schema with the
 * harness' own validator, so a schema/value mismatch surfaces here instead of
 * as an INVALID_TOOL_OUTPUT at call time.
 *
 * Run: `node scripts/check-tools.mjs`
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateJsonSchemaValue, assertSupportedJsonSchema } from '/home/wadd/.nvm/versions/node/v26.13.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import { PanelEngine } from '../lib/engine.js'
import { PanelStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
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
  console.log('  FAIL ' + message + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)))
}

/** Validate one tool result value against its declared schema. */
function expectValidOutput(tool, value, label) {
  assertSupportedJsonSchema(tool.output.schema)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  expect(violations.length === 0, label + ' output matches its schema', violations)
  const content = tool.output.render({}, value)
  expect(Array.isArray(content) && content.length > 0 && content[0].type === 'text', label + ' renders text content')
}

async function main() {
  const mock = await startMock()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cronops-tools-'))
  const store = new PanelStore(join(dir, 'dsh-cronops.json'))
  store.create({
    alias: 'mock',
    baseUrl: mock.baseUrl,
    auth: { kind: 'open', clientId: 'mock-client', clientSecret: 'mock-secret' },
  })
  const engine = new PanelEngine(store, { timeoutMs: 5000 })
  const tools = Object.fromEntries(buildTools(engine, store).map(tool => [tool.name, tool]))

  try {
    expect(Object.keys(tools).length === 4, 'four tools are built', Object.keys(tools))

    for (const tool of Object.values(tools)) {
      expect(typeof tool.execute === 'function' && typeof tool.description === 'string' && tool.description.length > 20,
        `${tool.name}: has a description and an executor`)
      assertSupportedJsonSchema(tool.output.schema)
      const parameterViolations = validateJsonSchemaValue(tool.parameters, { action: 'list' }, 'args')
      expect(Array.isArray(parameterViolations), `${tool.name}: parameters schema is accepted by the validator`)
    }

    const panelList = await tools.cronops_panels.execute({ action: 'list' })
    expectValidOutput(tools.cronops_panels, panelList, 'cronops_panels list')
    const panelText = tools.cronops_panels.output.render({}, panelList)[0].text
    expect(/appKey/.test(panelText) && panelText.includes('mock-client'),
      'panel list renders the appKey column', panelText)
    expectValidOutput(tools.cronops_panels, await tools.cronops_panels.execute({ action: 'test', alias: 'mock' }), 'cronops_panels test')
    expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({ action: 'list' }), 'cronops_envs list')
    expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({
      action: 'create',
      envs: [{ name: 'TOOL_VAR', value: 'v' }],
    }), 'cronops_envs create')
    const envList = await tools.cronops_envs.execute({ action: 'list', searchValue: 'TOOL_VAR' })
    const envId = envList.envs[0].id
    expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({
      action: 'update',
      env: { id: envId, value: 'v2' },
    }), 'cronops_envs update')
    expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({ action: 'disable', ids: [envId] }), 'cronops_envs disable')
    expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({ action: 'delete', ids: [envId] }), 'cronops_envs delete')

    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'list' }), 'cronops_crons list')
    const created = await tools.cronops_crons.execute({
      action: 'create',
      cron: { name: 'tool-task', command: 'task t.js', schedule: '0 0 * * *' },
    })
    expectValidOutput(tools.cronops_crons, created, 'cronops_crons create')
    const cronId = created.result.id
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'get', id: cronId }), 'cronops_crons get')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'update', id: cronId, patch: { name: 'renamed' } }), 'cronops_crons update')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'run', ids: [cronId] }), 'cronops_crons run')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'stop', ids: [cronId] }), 'cronops_crons stop')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'log', id: cronId, limit: 4096 }), 'cronops_crons log')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'preview', schedule: '*/5 * * * *' }), 'cronops_crons preview')
    expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'delete', ids: [cronId] }), 'cronops_crons delete')

    expectValidOutput(tools.cronops_api, await tools.cronops_api.execute({
      method: 'GET',
      path: '/dependencies',
    }), 'cronops_api allowed call')

    // ---- daidai panel: same four tools, different wire contract
    const dd = await startDaidaiMock()
    try {
      store.create({
        alias: 'dd',
        kind: 'daidai',
        baseUrl: dd.baseUrl,
        auth: { kind: 'open', appKey: 'dd-key', appSecret: 'dd-secret' },
      })
      expectValidOutput(tools.cronops_panels, await tools.cronops_panels.execute({ action: 'list' }), 'daidai panels list')
      expectValidOutput(tools.cronops_panels, await tools.cronops_panels.execute({ action: 'test', alias: 'dd' }), 'daidai panels test')
      expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({ action: 'list', alias: 'dd' }), 'daidai envs list')
      expectValidOutput(tools.cronops_envs, await tools.cronops_envs.execute({
        action: 'create',
        alias: 'dd',
        envs: [{ name: 'TOOL_DD', value: 'v' }],
      }), 'daidai envs create')
      expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'list', alias: 'dd' }), 'daidai crons list')
      const ddCreated = await tools.cronops_crons.execute({
        action: 'create',
        alias: 'dd',
        cron: { name: 'tool-dd', command: 'task dd.js', schedule: '0 0 * * *' },
      })
      expectValidOutput(tools.cronops_crons, ddCreated, 'daidai crons create')
      const ddId = ddCreated.result.data.id
      expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'run', alias: 'dd', ids: [ddId] }), 'daidai crons run')
      expectValidOutput(tools.cronops_crons, await tools.cronops_crons.execute({ action: 'log', alias: 'dd', id: ddId }), 'daidai crons log')
      expectValidOutput(tools.cronops_api, await tools.cronops_api.execute({
        method: 'GET',
        path: '/tasks',
        alias: 'dd',
      }), 'daidai api allowed call')
      let ddDenied = false
      try {
        await tools.cronops_api.execute({ method: 'GET', path: '/open-api/apps', alias: 'dd' })
      } catch (error) {
        ddDenied = /拒绝访问/.test(String(error.message))
      }
      expect(ddDenied, 'daidai api refuses /open-api')
    } finally {
      await dd.close()
    }

    // 404 → path hint; 403 → scope hint
    let notFoundHint = ''
    try {
      await tools.cronops_api.execute({ method: 'GET', path: '/subscriptions/unknown-endpoint' })
    } catch (error) {
      notFoundHint = String(error.message)
    }
    expect(/路径不存在/.test(notFoundHint) && /常用/.test(notFoundHint), '404 carries the path cheatsheet', notFoundHint)

    let scopeHint = ''
    try {
      await tools.cronops_api.execute({ method: 'GET', path: '/subscriptions/denied' })
    } catch (error) {
      scopeHint = String(error.message)
    }
    expect(/scope/.test(scopeHint), '403 explains the missing scope', scopeHint)

    // Retired route (410) and celebrate validation failures must carry the
    // exact retry shape.
    let retiredHint = ''
    try {
      await tools.cronops_api.execute({ method: 'GET', path: '/scripts/meituan.js' })
    } catch (error) {
      retiredHint = String(error.message)
    }
    expect(/已下线/.test(retiredHint) && /\/scripts\/detail\?path=/.test(retiredHint),
      '410 restates the replacement call', retiredHint)

    let validationHint = ''
    try {
      await tools.cronops_api.execute({ method: 'GET', path: '/scripts/detail', query: { path: 'x.js' } })
    } catch (error) {
      validationHint = String(error.message)
    }
    expect(/file/.test(validationHint), 'validation failure names the missing field', validationHint)

    let denied = false
    try {
      await tools.cronops_api.execute({ method: 'GET', path: '/apps' })
    } catch (error) {
      denied = /拒绝访问/.test(String(error.message))
    }
    expect(denied, 'cronops_api refuses /apps')
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
