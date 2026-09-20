import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { installHermes } from '../dist/index.js'
import { startFakeEvalService, verdict } from './helpers/fake-service.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = join(packageRoot, 'test', 'harness', 'hermes_runner.py')
const execFileAsync = promisify(execFile)

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'eval-jev-hermes-'))
}

/** Install the real template into a temp HERMES_HOME and return the plugin dir. */
function installFixture(home) {
  const result = installHermes({ global: true, home, env: { HERMES_HOME: join(home, '.hermes'), PATH: '' }, enable: false })
  const pluginDir = join(home, '.hermes', 'plugins', 'eval-jev-guardrails')
  assert.ok(existsSync(join(pluginDir, 'plugin.yaml')))
  assert.ok(existsSync(join(pluginDir, '__init__.py')))
  assert.equal(result.files.length, 2)
  return pluginDir
}

async function runHermes(pluginDir, tool, args, env) {
  try {
    const { stdout } = await execFileAsync('python3', [runner, pluginDir, tool, JSON.stringify(args)], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    return JSON.parse(stdout)
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(`python harness failed: ${error instanceof Error ? error.message : String(error)}\n${stderr}`)
  }
}

function baseEnv(home, baseUrl, extra = {}) {
  return { ...process.env, HOME: home, EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: baseUrl, ...extra }
}

test('generated plugin registers pre_tool_call and blocks a destructive tool call', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const output = await runHermes(pluginDir, 'Bash', { command: 'rm -rf /' }, baseEnv(home, service.url))
    assert.deepEqual(output.registered, ['pre_tool_call'])
    assert.equal(output.result.action, 'block')
    assert.match(output.result.message, /destructive|Blocked by eval guardrails/i)

    const request = service.requests.at(-1)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/evaluate')
    assert.equal(request.headers.authorization, 'Bearer eval_test')
    assert.equal(request.body.side, 'action')
    assert.equal(request.body.action.tool, 'Bash')
    assert.deepEqual(request.body.action.arguments, { command: 'rm -rf /' })
    assert.equal(request.body.action.sessionID, 'session-test')
    assert.equal(request.body.action.callID, 'call-test')
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('generated plugin allows a benign tool call by returning None', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const output = await runHermes(pluginDir, 'Read', { file: 'README.md' }, baseEnv(home, service.url))
    assert.equal(output.result, null)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('review verdict denies by default and EVAL_REVIEW_MODE=allow permits it', async () => {
  const service = await startFakeEvalService({
    route: (request) =>
      request.url === '/v1/evaluate'
        ? { status: 200, body: { verdict: verdict('review'), credits: { remaining: 1, charged: 1 } } }
        : undefined,
  })
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const denied = await runHermes(pluginDir, 'Bash', { command: 'review-me' }, baseEnv(home, service.url))
    assert.equal(denied.result.action, 'block')
    assert.match(denied.result.message, /review/i)

    const allowed = await runHermes(pluginDir, 'Bash', { command: 'review-me' }, baseEnv(home, service.url, { EVAL_REVIEW_MODE: 'allow' }))
    assert.equal(allowed.result, null)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('support verdict blocks in the Python hook too', async () => {
  const service = await startFakeEvalService({
    route: (request) =>
      request.url === '/v1/evaluate'
        ? { status: 200, body: { verdict: verdict('support'), credits: { remaining: 1, charged: 1 } } }
        : undefined,
  })
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const output = await runHermes(pluginDir, 'Bash', { command: 'support-me' }, baseEnv(home, service.url))
    assert.equal(output.result.action, 'block')
    assert.match(output.result.message, /support/i)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('service failures follow EVAL_FAIL_MODE=open|closed', async () => {
  const service = await startFakeEvalService({ route: () => ({ status: 500, body: { error: 'boom' } }) })
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const open = await runHermes(pluginDir, 'Bash', { command: 'ls' }, baseEnv(home, service.url, { EVAL_FAIL_MODE: 'open' }))
    assert.equal(open.result, null)

    const closed = await runHermes(pluginDir, 'Bash', { command: 'ls' }, baseEnv(home, service.url, { EVAL_FAIL_MODE: 'closed' }))
    assert.equal(closed.result.action, 'block')
    assert.match(closed.result.message, /EVAL_FAIL_MODE=closed/)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('missing key fails according to EVAL_FAIL_MODE', async () => {
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const env = {
      ...process.env,
      HOME: home,
      EVAL_API_KEY: '',
      EVAL_CONFIG_PATH: join(home, 'does-not-exist.json'),
      EVAL_FAIL_MODE: 'closed',
    }
    const blocked = await runHermes(pluginDir, 'Bash', { command: 'ls' }, env)
    assert.equal(blocked.result.action, 'block')
    assert.match(blocked.result.message, /EVAL_API_KEY|no API key/i)

    const open = await runHermes(pluginDir, 'Bash', { command: 'ls' }, { ...env, EVAL_FAIL_MODE: 'open' })
    assert.equal(open.result, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('plugin.yaml declares the hook and the installed version matches the package', () => {
  const home = tempHome()
  try {
    const pluginDir = installFixture(home)
    const manifest = readFileSync(join(pluginDir, 'plugin.yaml'), 'utf8')
    assert.match(manifest, /^name: eval-jev-guardrails$/m)
    assert.match(manifest, /pre_tool_call/)
    assert.match(manifest, /^version: 0\.1\.0$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
