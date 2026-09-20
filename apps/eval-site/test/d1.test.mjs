import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../dist/app.js'
import { sha256Hex } from '../dist/crypto.js'
import { callApi, createSqliteD1, makeEnv, makeUpstream } from './helpers.mjs'

test('migrations create the schema and indexes', async (t) => {
  const sqlite = await createSqliteD1()
  if (sqlite === null) {
    t.skip('node:sqlite is unavailable on this Node version')
    return
  }
  const tables = sqlite.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  assert.deepEqual(tables, ['api_keys', 'credit_ledger', 'evaluations', 'stripe_events', 'users'])

  const indexes = sqlite.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const expected of [
    'idx_api_keys_user',
    'idx_credit_ledger_user_created',
    'idx_evaluations_cache',
    'idx_evaluations_user_created',
    'idx_stripe_events_session',
    'idx_stripe_events_user',
    'idx_users_github_id',
  ]) {
    assert.ok(indexes.includes(expected), `missing index ${expected}`)
  }

  // 0001 is written with IF NOT EXISTS and is safe to re-apply.
  const migration = (await import('node:fs')).readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
  sqlite.db.exec(migration)
})

test('D1Store drives admin minting, evaluate credits, cache hits, and degradation', async (t) => {
  const sqlite = await createSqliteD1()
  if (sqlite === null) {
    t.skip('node:sqlite is unavailable on this Node version')
    return
  }

  const upstream = makeUpstream({
    bodyHook: async (body, callNumber) => {
      if (callNumber === 2) throw new Error('second call exploded')
      return undefined
    },
  })
  const app = createApp({ fetch: upstream.fetch })
  const env = makeEnv({ DB: sqlite.d1 })

  const minted = await callApi(app, env, 'POST', '/admin/keys', {
    token: 'admin-test-token',
    body: { email: 'd1@example.com', name: 'd1-key' },
  })
  assert.equal(minted.status, 201)
  assert.match(minted.body.apiKey, /^eval_/)
  assert.equal(minted.body.credits.remaining, 10_000)

  const keyRow = sqlite.db.prepare('SELECT key_hash, plan FROM api_keys').get()
  assert.equal(keyRow.key_hash, await sha256Hex(minted.body.apiKey))
  assert.equal(keyRow.plan, null)
  assert.notEqual(keyRow.key_hash, minted.body.apiKey)

  const first = await callApi(app, env, 'POST', '/v1/evaluate', {
    token: minted.body.apiKey,
    body: { side: 'input', state: 'first request' },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.credits.charged, 1)
  assert.equal(first.body.credits.remaining, 9_999)
  assert.equal(upstream.calls.length, 1)

  const second = await callApi(app, env, 'POST', '/v1/evaluate', {
    token: minted.body.apiKey,
    body: { side: 'input', state: 'first request' },
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.verdict.cached, true)
  assert.equal(second.body.credits.charged, 0.1)
  assert.equal(second.body.credits.remaining, 9_998.9)
  assert.equal(upstream.calls.length, 1)

  const third = await callApi(app, env, 'POST', '/v1/evaluate', {
    token: minted.body.apiKey,
    body: { side: 'input', state: 'second request' },
  })
  assert.equal(third.status, 200)
  assert.equal(third.body.verdict.degraded, true)
  assert.equal(third.body.credits.charged, 0)
  assert.equal(third.body.credits.remaining, 9_998.9)
  assert.equal(upstream.calls.length, 2)

  const balance = sqlite.db.prepare('SELECT credit_micros FROM users').get()
  assert.equal(balance.credit_micros, 9_998_900_000)

  const ledgerKinds = sqlite.db
    .prepare('SELECT kind, amount_micros FROM credit_ledger ORDER BY rowid')
    .all()
    .map((row) => [row.kind, row.amount_micros])
  assert.deepEqual(ledgerKinds, [
    ['grant', 10_000_000_000],
    ['reserve', -1_000_000],
    ['cache_hit', -100_000],
    ['reserve', -1_000_000],
    ['refund', 1_000_000],
  ])

  const evaluationRows = sqlite.db
    .prepare('SELECT status, degraded, cached_hit FROM evaluations ORDER BY created_at, rowid')
    .all()
  assert.deepEqual(
    evaluationRows.map((row) => [row.status, row.degraded, row.cached_hit]),
    [
      ['complete', 0, 0],
      ['cached', 0, 1],
      ['degraded', 1, 0],
    ],
  )
})

test('D1Store.processStripeEvent grants each Stripe event exactly once', async (t) => {
  const sqlite = await createSqliteD1()
  if (sqlite === null) {
    t.skip('node:sqlite is unavailable on this Node version')
    return
  }
  const { D1Store } = await import('../dist/d1-store.js')
  const store = new D1Store(sqlite.d1)
  const now = 1_700_000_000_000
  await store.createAccount({ id: 'user_stripe', email: null, displayName: null, plan: 'standard', now })

  const event = {
    eventId: 'evt_d1_1',
    eventType: 'checkout.session.completed',
    sessionId: 'cs_d1_1',
    userId: 'user_stripe',
    creditsMicros: 5_000_000,
    note: 'Stripe credit pack p5000',
    now,
  }
  const first = await store.processStripeEvent(event)
  assert.deepEqual(first, { granted: true })
  const duplicate = await store.processStripeEvent(event)
  assert.deepEqual(duplicate, { granted: false })

  const account = await store.getAccount('user_stripe')
  assert.equal(account.creditMicros, 5_000_000)
  const ledger = sqlite.db.prepare('SELECT kind, amount_micros, balance_after_micros FROM credit_ledger').all()
  assert.deepEqual(ledger.map((row) => [row.kind, row.amount_micros, row.balance_after_micros]), [
    ['grant', 5_000_000, 5_000_000],
  ])
  const events = sqlite.db.prepare('SELECT id, status FROM stripe_events').all()
  assert.deepEqual(events.map((row) => [row.id, row.status]), [['evt_d1_1', 'processed']])
})

test('D1Store refuses a debit that exceeds the balance and keeps the ledger consistent', async (t) => {
  const sqlite = await createSqliteD1()
  if (sqlite === null) {
    t.skip('node:sqlite is unavailable on this Node version')
    return
  }
  const { D1Store } = await import('../dist/d1-store.js')
  const store = new D1Store(sqlite.d1)
  const now = 1_700_000_000_000
  await store.createAccount({ id: 'user_broke', email: null, displayName: null, plan: 'standard', now })
  await store.applyLedgerEntry({ userId: 'user_broke', amountMicros: 500_000, kind: 'grant', now })
  const denied = await store.reserveCredits({ userId: 'user_broke', amountMicros: 1_000_000, kind: 'reserve', now })
  assert.equal(denied.ok, false)
  assert.equal(denied.balanceMicros, 500_000)
  const allowed = await store.reserveCredits({ userId: 'user_broke', amountMicros: 500_000, kind: 'reserve', now })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.balanceMicros, 0)
  const rows = sqlite.db.prepare('SELECT amount_micros, balance_after_micros, kind FROM credit_ledger ORDER BY rowid').all()
  assert.deepEqual(
    rows.map((row) => [row.kind, row.amount_micros, row.balance_after_micros]),
    [
      ['grant', 500_000, 500_000],
      ['reserve', -500_000, 0],
    ],
  )
})
