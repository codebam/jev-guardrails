import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenCodeHooks, createOpenCodePlugin } from '../dist/opencode.js'
import { startFakeEvalService, verdict } from './helpers/fake-service.mjs'

const noopLogger = () => {}

test('createOpenCodePlugin returns a plugin whose tool.execute.before blocks a destructive action', async () => {
  const service = await startFakeEvalService()
  try {
    const plugin = createOpenCodePlugin({
      apiKey: 'eval_test',
      baseUrl: service.url,
      logger: noopLogger,
    })
    const hooks = plugin({ directory: '/repo' })
    assert.equal(typeof hooks['tool.execute.before'], 'function')

    await assert.rejects(
      () =>
        hooks['tool.execute.before'](
          { tool: 'Bash', sessionID: 'session-1', callID: 'call-1' },
          { args: { command: 'rm -rf /' } },
        ),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /[Bb]locked by eval guardrails/)
        assert.match(error.message, /destructive/)
        return true
      },
    )

    const request = service.requests.at(-1)
    assert.equal(request.url, '/v1/evaluate')
    assert.equal(request.body.side, 'action')
    assert.equal(request.body.action.tool, 'Bash')
    assert.deepEqual(request.body.action.arguments, { command: 'rm -rf /' })
    assert.equal(request.body.action.workspace, '/repo')
    assert.equal(request.body.action.sessionID, 'session-1')
    assert.equal(request.body.action.callID, 'call-1')
  } finally {
    await service.close()
  }
})

test('allow verdict returns and does not throw', async () => {
  const service = await startFakeEvalService()
  try {
    const hooks = createOpenCodeHooks({ apiKey: 'eval_test', baseUrl: service.url, logger: noopLogger })
    await hooks['tool.execute.before']({ tool: 'Read' }, { args: { file: 'README.md' } })
    assert.equal(service.requests.length, 1)
  } finally {
    await service.close()
  }
})

test('support verdict blocks like block', async () => {
  const service = await startFakeEvalService()
  try {
    const hooks = createOpenCodeHooks({ apiKey: 'eval_test', baseUrl: service.url, logger: noopLogger })
    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'support-me' } }),
      /respond supportively|support/i,
    )
  } finally {
    await service.close()
  }
})

test('review verdict denies by default and can be configured to allow', async () => {
  const service = await startFakeEvalService()
  try {
    const denyHooks = createOpenCodeHooks({ apiKey: 'eval_test', baseUrl: service.url, logger: noopLogger })
    await assert.rejects(
      () => denyHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'review-me' } }),
      /review/i,
    )

    const allowHooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      reviewMode: 'allow',
      logger: noopLogger,
    })
    await allowHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'review-me' } })
  } finally {
    await service.close()
  }
})

test('service failure follows EVAL_FAIL_MODE (open default, closed blocks)', async () => {
  const service = await startFakeEvalService({ route: () => ({ status: 500, body: { error: 'boom' } }) })
  try {
    const openHooks = createOpenCodeHooks({ apiKey: 'eval_test', baseUrl: service.url, logger: noopLogger })
    await openHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'ls' } })

    const closedHooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      failMode: 'closed',
      logger: noopLogger,
    })
    await assert.rejects(
      () => closedHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'ls' } }),
      /EVAL_FAIL_MODE=closed/,
    )

    const reviewHooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      failMode: 'review',
      logger: noopLogger,
    })
    await assert.rejects(
      () => reviewHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'ls' } }),
      /EVAL_FAIL_MODE=review/,
    )
  } finally {
    await service.close()
  }
})

test('EVAL_SKIP_TOOLS bypasses selected tools without a request', async () => {
  const service = await startFakeEvalService()
  try {
    const hooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      env: { EVAL_SKIP_TOOLS: 'Read,List' },
      logger: noopLogger,
    })
    await hooks['tool.execute.before']({ tool: 'Read' }, { args: { file: 'x' } })
    assert.equal(service.requests.length, 0)
  } finally {
    await service.close()
  }
})

test('hooks use options and env for review/fail policy (env wins only when options absent)', async () => {
  const service = await startFakeEvalService({
    route: () => ({ status: 200, body: { verdict: verdict('review'), credits: { remaining: 1, charged: 1 } } }),
  })
  try {
    const envHooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      env: { EVAL_REVIEW_MODE: 'allow' },
      logger: noopLogger,
    })
    await envHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'review-me' } })

    const optionHooks = createOpenCodeHooks({
      apiKey: 'eval_test',
      baseUrl: service.url,
      reviewMode: 'deny',
      env: { EVAL_REVIEW_MODE: 'allow' },
      logger: noopLogger,
    })
    await assert.rejects(() => optionHooks['tool.execute.before']({ tool: 'Bash' }, { args: { command: 'review-me' } }))
  } finally {
    await service.close()
  }
})
