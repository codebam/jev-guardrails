import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EVAL_CREDIT_PACKS,
  EvalApiError,
  EvalConfigError,
  EvalGuardrailsClient,
  EvalTransportError,
  resolveEvalConfig,
} from '../dist/index.js'
import { startFakeEvalService } from './helpers/fake-service.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'eval-jev-client-'))
}

function writeConfig(home, config) {
  const path = join(home, '.config', 'eval-jev', 'config.json')
  mkdirSync(join(home, '.config', 'eval-jev'), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
  return path
}

test('config resolution: explicit > env > config file > default', () => {
  const home = tempHome()
  try {
    const configPath = writeConfig(home, { apiKey: 'eval_file', baseUrl: 'http://file.test' })

    const fromFile = resolveEvalConfig({ home, env: { HOME: home } })
    assert.equal(fromFile.apiKey, 'eval_file')
    assert.equal(fromFile.apiKeySource, 'config')
    assert.equal(fromFile.baseUrl, 'http://file.test')
    assert.equal(fromFile.baseUrlSource, 'config')
    assert.equal(fromFile.configPath, configPath)

    const fromEnv = resolveEvalConfig({
      home,
      env: { HOME: home, EVAL_API_KEY: 'eval_env', EVAL_BASE_URL: 'http://env.test/' },
    })
    assert.equal(fromEnv.apiKey, 'eval_env')
    assert.equal(fromEnv.apiKeySource, 'env')
    assert.equal(fromEnv.baseUrl, 'http://env.test')

    const fromOption = resolveEvalConfig({
      home,
      apiKey: 'eval_option',
      baseUrl: 'http://option.test',
      env: { HOME: home, EVAL_API_KEY: 'eval_env', EVAL_BASE_URL: 'http://env.test' },
    })
    assert.equal(fromOption.apiKey, 'eval_option')
    assert.equal(fromOption.baseUrlSource, 'option')

    const emptyHome = tempHome()
    try {
      const defaults = new EvalGuardrailsClient({ home: emptyHome, env: {}, fetch: fetch })
      assert.equal(defaults.hasApiKey, false)
      assert.equal(defaults.baseUrl, 'https://eval.seanbehan.ca')
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
    assert.ok(statSync(configPath).mode & 0o600, 'config fixture should be mode 600')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('evaluate posts side/state/action with bearer auth and parses a blocked verdict', async () => {
  const service = await startFakeEvalService()
  try {
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    const result = await client.evaluate(
      'action',
      { tool: 'Bash', arguments: { command: 'rm -rf /' } },
      { tool: 'Bash', arguments: { command: 'rm -rf /' }, workspace: '/repo' },
    )
    assert.equal(result.verdict.action, 'block')
    assert.equal(result.credits.remaining, 41)

    const request = service.requests.at(-1)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/evaluate')
    assert.equal(request.headers.authorization, 'Bearer eval_test')
    assert.equal(request.body.side, 'action')
    assert.equal(request.body.state.tool, 'Bash')
    assert.equal(request.body.action.tool, 'Bash')
    assert.equal(request.body.action.arguments.command, 'rm -rf /')
    assert.equal(request.body.action.workspace, '/repo')

    // allow path is a normal 200 too
    const allowed = await client.evaluate('input', 'hello world')
    assert.equal(allowed.verdict.action, 'allow')
  } finally {
    await service.close()
  }
})

test('evaluate requires an action descriptor for side=action', async () => {
  const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(() => client.evaluate('action', 'state'), EvalConfigError)
  await assert.rejects(() => client.evaluate('nonsense', 'state'), EvalConfigError)
})

test('systemOne, credits, and me use the documented routes', async () => {
  const service = await startFakeEvalService()
  try {
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    const questions = { destructive: { type: 'noul' } }
    const systemOne = await client.systemOne({ state: { tool: 'Bash' }, questions, model: 'jev-latest' })
    assert.equal(systemOne.model, 'fake/jev-test')
    assert.equal(systemOne.answers.destructive.type, 'noul')

    const credits = await client.credits()
    assert.equal(credits.remaining, 37)

    const me = await client.me()
    assert.equal(me.login, 'tester')

    assert.deepEqual(
      service.requests.map((request) => `${request.method} ${request.url}`),
      ['POST /v1/systemone', 'GET /v1/credits', 'GET /v1/me'],
    )
    for (const request of service.requests) assert.equal(request.headers.authorization, 'Bearer eval_test')
  } finally {
    await service.close()
  }
})

test('missing key fails before any network request', async () => {
  const service = await startFakeEvalService()
  try {
    const client = new EvalGuardrailsClient({ home: tempHome(), env: {}, baseUrl: service.url, fetch: fetch })
    await assert.rejects(() => client.credits(), (error) => {
      assert.ok(error instanceof EvalConfigError)
      assert.match(error.message, /EVAL_API_KEY/)
      assert.match(error.message, /eval-jev login/)
      return true
    })
    assert.equal(service.requests.length, 0)
  } finally {
    await service.close()
  }
})

test('HTTP failures surface as EvalApiError with status and body', async () => {
  const service = await startFakeEvalService({
    route: (request) =>
      request.url === '/v1/evaluate'
        ? { status: 402, body: { error: 'insufficient credits', code: 'insufficient_credits' } }
        : undefined,
  })
  try {
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    await assert.rejects(
      () => client.evaluate('action', {}, { tool: 'Bash', arguments: {} }),
      (error) => {
        assert.ok(error instanceof EvalApiError)
        assert.equal(error.status, 402)
        assert.equal(error.apiCode, 'insufficient_credits')
        assert.match(error.message, /insufficient credits/)
        return true
      },
    )
  } finally {
    await service.close()
  }
})

test('config file fallback is actually used for a request', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  try {
    writeConfig(home, { apiKey: 'eval_from_file', baseUrl: service.url })
    const client = new EvalGuardrailsClient({ home, env: {} })
    const credits = await client.credits()
    assert.equal(credits.remaining, 37)
    assert.equal(service.requests.at(-1).headers.authorization, 'Bearer eval_from_file')
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('checkout posts the pack and returns the Stripe Checkout URL', async () => {
  const service = await startFakeEvalService()
  try {
    assert.deepEqual(EVAL_CREDIT_PACKS, ['p5000', 'p25000', 'p100000', 'p500000'])
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    const checkout = await client.checkout('p25000')
    assert.equal(checkout.url, 'https://checkout.stripe.test/session/p25000')
    assert.equal(checkout.id, 'cs_test_p25000')

    const request = service.requests.at(-1)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/billing/checkout')
    assert.equal(request.headers.authorization, 'Bearer eval_test')
    assert.deepEqual(request.body, { pack: 'p25000' })
  } finally {
    await service.close()
  }
})

test('checkout rejects an unknown pack before any network request', async () => {
  const service = await startFakeEvalService()
  try {
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    await assert.rejects(() => client.checkout('p1'), (error) => {
      assert.ok(error instanceof EvalConfigError)
      assert.match(error.message, /p5000, p25000, p100000, p500000/)
      assert.match(error.message, /p1/)
      return true
    })
    assert.equal(service.requests.length, 0)
  } finally {
    await service.close()
  }
})

test('checkout rejects a response without a Stripe URL', async () => {
  const service = await startFakeEvalService({
    route: (request) =>
      request.url === '/v1/billing/checkout' ? { status: 200, body: { id: 'cs_missing_url' } } : undefined,
  })
  try {
    const client = new EvalGuardrailsClient({ apiKey: 'eval_test', baseUrl: service.url })
    await assert.rejects(() => client.checkout('p5000'), (error) => {
      assert.ok(error instanceof EvalTransportError)
      assert.match(error.message, /no Stripe Checkout URL/)
      return true
    })
  } finally {
    await service.close()
  }
})
