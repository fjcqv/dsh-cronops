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

    expectValidOutput(tools.qinglong_panels, await tools.qinglong_panels.execute({ action: 'list' }), 'qinglong_panels list')
    expectValidOutput(tools.qinglong_panels, await tools.qinglong_panels.execute({ action: 'test', alias: 'mock' }), 'qinglong_panels test')
    expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({ action: 'list' }), 'qinglong_envs list')
    expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({
      action: 'create',
      envs: [{ name: 'TOOL_VAR', value: 'v' }],
    }), 'qinglong_envs create')
    const envList = await tools.qinglong_envs.execute({ action: 'list', searchValue: 'TOOL_VAR' })
    const envId = envList.envs[0].id
    expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({
      action: 'update',
      env: { id: envId, value: 'v2' },
    }), 'qinglong_envs update')
    expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({ action: 'disable', ids: [envId] }), 'qinglong_envs disable')
    expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({ action: 'delete', ids: [envId] }), 'qinglong_envs delete')

    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'list' }), 'qinglong_crons list')
    const created = await tools.qinglong_crons.execute({
      action: 'create',
      cron: { name: 'tool-task', command: 'task t.js', schedule: '0 0 * * *' },
    })
    expectValidOutput(tools.qinglong_crons, created, 'qinglong_crons create')
    const cronId = created.result.id
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'get', id: cronId }), 'qinglong_crons get')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'update', id: cronId, patch: { name: 'renamed' } }), 'qinglong_crons update')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'run', ids: [cronId] }), 'qinglong_crons run')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'stop', ids: [cronId] }), 'qinglong_crons stop')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'log', id: cronId, limit: 4096 }), 'qinglong_crons log')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'preview', schedule: '*/5 * * * *' }), 'qinglong_crons preview')
    expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'delete', ids: [cronId] }), 'qinglong_crons delete')

    expectValidOutput(tools.qinglong_api, await tools.qinglong_api.execute({
      method: 'GET',
      path: '/dependencies',
    }), 'qinglong_api allowed call')

    // ---- daidai panel: same four tools, different wire contract
    const dd = await startDaidaiMock()
    try {
      store.create({
        alias: 'dd',
        kind: 'daidai',
        baseUrl: dd.baseUrl,
        auth: { kind: 'open', appKey: 'dd-key', appSecret: 'dd-secret' },
      })
      expectValidOutput(tools.qinglong_panels, await tools.qinglong_panels.execute({ action: 'list' }), 'daidai panels list')
      expectValidOutput(tools.qinglong_panels, await tools.qinglong_panels.execute({ action: 'test', alias: 'dd' }), 'daidai panels test')
      expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({ action: 'list', alias: 'dd' }), 'daidai envs list')
      expectValidOutput(tools.qinglong_envs, await tools.qinglong_envs.execute({
        action: 'create',
        alias: 'dd',
        envs: [{ name: 'TOOL_DD', value: 'v' }],
      }), 'daidai envs create')
      expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'list', alias: 'dd' }), 'daidai crons list')
      const ddCreated = await tools.qinglong_crons.execute({
        action: 'create',
        alias: 'dd',
        cron: { name: 'tool-dd', command: 'task dd.js', schedule: '0 0 * * *' },
      })
      expectValidOutput(tools.qinglong_crons, ddCreated, 'daidai crons create')
      const ddId = ddCreated.result.data.id
      expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'run', alias: 'dd', ids: [ddId] }), 'daidai crons run')
      expectValidOutput(tools.qinglong_crons, await tools.qinglong_crons.execute({ action: 'log', alias: 'dd', id: ddId }), 'daidai crons log')
      expectValidOutput(tools.qinglong_api, await tools.qinglong_api.execute({
        method: 'GET',
        path: '/tasks',
        alias: 'dd',
      }), 'daidai api allowed call')
      let ddDenied = false
      try {
        await tools.qinglong_api.execute({ method: 'GET', path: '/open-api/apps', alias: 'dd' })
      } catch (error) {
        ddDenied = /拒绝访问/.test(String(error.message))
      }
      expect(ddDenied, 'daidai api refuses /open-api')
    } finally {
      await dd.close()
    }

    let denied = false
    try {
      await tools.qinglong_api.execute({ method: 'GET', path: '/apps' })
    } catch (error) {
      denied = /拒绝访问/.test(String(error.message))
    }
    expect(denied, 'qinglong_api refuses /apps')
  } finally {
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
