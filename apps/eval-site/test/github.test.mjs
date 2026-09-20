import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../dist/app.js'
import { callApi, makeEnv, MemoryStore } from './helpers.mjs'

/** Fake GitHub endpoints used by the device flow. */
function makeGithubUpstream(options = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const href = String(url)
    const headers = new Headers(init.headers ?? {})
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url: href, method: init.method, headers, body })
    if (href === 'https://github.com/login/device/code') {
      return Response.json({
        device_code: 'device-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
        expires_in: 900,
        interval: 5,
      })
    }
    if (href === 'https://github.com/login/oauth/access_token') {
      const deviceCode = body?.device_code
      if (deviceCode === 'pending-code') {
        return Response.json({
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending.',
          error_uri: 'https://docs.github.com/developers/apps/authorizing-oauth-apps',
        })
      }
      if (deviceCode === 'denied-code') return Response.json({ error: 'access_denied', error_description: 'The user denied the request.' })
      if (deviceCode === 'expired-code') return Response.json({ error: 'expired_token', error_description: 'The device code has expired.' })
      if (deviceCode === 'slow-code') return Response.json({ error: 'slow_down', error_description: 'Poll less frequently.' })
      return Response.json({ access_token: 'gho_secret_token', token_type: 'bearer', scope: 'read:user user:email' })
    }
    if (href === 'https://api.github.com/user') {
      return Response.json({ id: 4242, login: 'octocat', name: 'The Octocat', email: options.userEmail ?? null })
    }
    if (href === 'https://api.github.com/user/emails') {
      return Response.json(options.emails ?? [{ email: 'octo@example.com', primary: true, verified: true }])
    }
    throw new Error(`unexpected GitHub call: ${href}`)
  }
  return { fetch, calls }
}

test('POST /v1/auth/device proxies the GitHub device-code request', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream()
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_abc' })

  const response = await callApi(app, env, 'POST', '/v1/auth/device', {
    body: { client_id: 'client_abc', scope: 'read:user user:email' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.device_code, 'device-code-1')
  assert.equal(response.body.user_code, 'ABCD-1234')
  assert.equal(response.body.verification_uri, 'https://github.com/login/device')
  assert.equal(response.body.verification_uri_complete, 'https://github.com/login/device?user_code=ABCD-1234')
  assert.equal(response.body.expires_in, 900)
  assert.equal(response.body.interval, 5)

  assert.equal(github.calls.length, 1)
  const call = github.calls[0]
  assert.equal(call.url, 'https://github.com/login/device/code')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.get('accept'), 'application/json')
  assert.deepEqual(call.body, { client_id: 'client_abc', scope: 'read:user user:email' })
})

test('device start defaults to GITHUB_CLIENT_ID and rejects mismatches', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream()
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_env' })

  const noClient = await callApi(app, env, 'POST', '/v1/auth/device', { body: {} })
  assert.equal(noClient.status, 200)
  assert.deepEqual(github.calls[0].body, { client_id: 'client_env' })

  const mismatch = await callApi(app, env, 'POST', '/v1/auth/device', {
    body: { client_id: 'someone_else' },
  })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.error.code, 'invalid_client_id')
  assert.equal(github.calls.length, 1)

  const unconfigured = await callApi(app, makeEnv(), 'POST', '/v1/auth/device', { body: {} })
  assert.equal(unconfigured.status, 500)
  assert.equal(unconfigured.body.error.code, 'github_not_configured')
})

test('device token passes GitHub OAuth polling errors through verbatim with HTTP 200', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream()
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_abc' })

  const expectations = [
    ['pending-code', 'authorization_pending'],
    ['denied-code', 'access_denied'],
    ['expired-code', 'expired_token'],
    ['slow-code', 'slow_down'],
  ]
  for (const [deviceCode, error] of expectations) {
    const response = await callApi(app, env, 'POST', '/v1/auth/device/token', {
      body: { client_id: 'client_abc', device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.error, error)
    assert.equal(typeof response.body.error_description, 'string')
  }
  assert.equal(store.accounts.size, 0)
  assert.equal(store.keysByHash.size, 0)
  assert.equal(store.ledger.length, 0)
})

test('a first GitHub login creates the user, grants free credits, and mints a key', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream()
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_abc', EVAL_FREE_CREDITS: '7' })

  const response = await callApi(app, env, 'POST', '/v1/auth/device/token', {
    body: { device_code: 'success-code', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
  })
  assert.equal(response.status, 200)
  assert.match(response.body.apiKey, /^eval_[A-Za-z0-9_-]+$/)
  assert.equal(response.body.login, 'octocat')
  assert.equal(response.body.credits, 7)

  assert.equal(store.accounts.size, 1)
  const account = [...store.accounts.values()][0]
  assert.equal(account.githubId, '4242')
  assert.equal(account.githubLogin, 'octocat')
  assert.equal(account.email, 'octo@example.com')
  assert.equal(account.creditMicros, 7_000_000)
  assert.equal(store.keysByHash.size, 1)
  assert.deepEqual(
    store.ledger.map((entry) => [entry.kind, entry.amountMicros]),
    [['grant', 7_000_000]],
  )

  // The access token is used for the API calls but never persisted or logged.
  const persisted = JSON.stringify({
    accounts: [...store.accounts.values()],
    keys: [...store.keysByHash.values()],
    ledger: store.ledger,
  })
  assert.ok(!persisted.includes('gho_secret_token'))
  assert.ok(github.calls.some((call) => call.url === 'https://api.github.com/user'))
  assert.ok(github.calls.some((call) => call.url === 'https://api.github.com/user/emails'))
})

test('a returning GitHub login gets a fresh key but no second free grant', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream()
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_abc', EVAL_FREE_CREDITS: '7' })

  const first = await callApi(app, env, 'POST', '/v1/auth/device/token', { body: { device_code: 'success-code' } })
  const second = await callApi(app, env, 'POST', '/v1/auth/device/token', { body: { device_code: 'success-code-2' } })
  assert.equal(first.body.credits, 7)
  assert.equal(second.body.credits, 7)
  assert.notEqual(first.body.apiKey, second.body.apiKey)
  assert.equal(store.accounts.size, 1)
  assert.equal(store.keysByHash.size, 2)
  assert.deepEqual(
    store.ledger.map((entry) => [entry.kind, entry.amountMicros]),
    [['grant', 7_000_000]],
  )
})

test('GitHub login defaults to 250 free credits and uses a public email when present', async () => {
  const store = new MemoryStore()
  const github = makeGithubUpstream({ userEmail: 'Public@Example.com' })
  const app = createApp({ store, fetch: github.fetch })
  const env = makeEnv({ GITHUB_CLIENT_ID: 'client_abc' })

  const response = await callApi(app, env, 'POST', '/v1/auth/device/token', {
    body: { device_code: 'success-code' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.credits, 250)
  const account = [...store.accounts.values()][0]
  assert.equal(account.email, 'public@example.com')
  assert.ok(!github.calls.some((call) => call.url === 'https://api.github.com/user/emails'))
})
