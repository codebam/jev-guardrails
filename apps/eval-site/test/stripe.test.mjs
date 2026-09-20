import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { createApp } from '../dist/app.js'
import { callApi, makeEnv, MemoryStore, seedKey, throwIfCalled } from './helpers.mjs'

const WEBHOOK_SECRET = 'whsec_test_123'

function makeStripeUpstream() {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers ?? {}),
      form: typeof init.body === 'string' ? new URLSearchParams(init.body) : new URLSearchParams(),
    })
    return Response.json({
      id: 'cs_test_123',
      object: 'checkout.session',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    })
  }
  return { fetch, calls }
}

function stripeEnv(overrides = {}) {
  return makeEnv({
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_P5000: 'price_5000',
    STRIPE_PRICE_P25000: 'price_25000',
    STRIPE_PRICE_P100000: 'price_100000',
    STRIPE_PRICE_P500000: 'price_500000',
    EVAL_PUBLIC_URL: 'https://eval.example',
    ...overrides,
  })
}

function signedEvent(event, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify(event)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return { payload, header: `t=${timestamp},v1=${signature}` }
}

function completedEvent(overrides = {}) {
  return {
    id: overrides.id ?? 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: overrides.sessionId ?? 'cs_test_1',
        object: 'checkout.session',
        payment_status: overrides.paymentStatus ?? 'paid',
        metadata: {
          userId: overrides.userId ?? 'user_seed',
          credits: overrides.credits ?? '5000',
          pack: overrides.pack ?? 'p5000',
        },
      },
    },
  }
}

test('POST /v1/billing/checkout creates a Stripe Checkout Session for a pack', async () => {
  const store = new MemoryStore()
  const { token } = await seedKey(store, { credits: 10 })
  const stripe = makeStripeUpstream()
  const app = createApp({ store, fetch: stripe.fetch })

  const response = await callApi(app, stripeEnv(), 'POST', '/v1/billing/checkout', {
    token,
    body: { pack: 'p5000' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    id: 'cs_test_123',
  })

  assert.equal(stripe.calls.length, 1)
  const call = stripe.calls[0]
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.get('authorization'), 'Bearer sk_test_123')
  assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded')
  assert.equal(call.form.get('mode'), 'payment')
  assert.equal(call.form.get('line_items[0][price]'), 'price_5000')
  assert.equal(call.form.get('line_items[0][quantity]'), '1')
  assert.equal(call.form.get('metadata[userId]'), 'user_seed')
  assert.equal(call.form.get('metadata[credits]'), '5000')
  assert.equal(call.form.get('metadata[pack]'), 'p5000')
  assert.ok(call.form.get('success_url').startsWith('https://eval.example/'))
  assert.ok(call.form.get('cancel_url').startsWith('https://eval.example/'))
})

test('checkout maps every pack to its Stripe price and credit amount', async () => {
  const store = new MemoryStore()
  const { token } = await seedKey(store, { credits: 10 })
  const stripe = makeStripeUpstream()
  const app = createApp({ store, fetch: stripe.fetch })
  const env = stripeEnv()
  const packs = [
    ['p5000', 'price_5000', '5000'],
    ['p25000', 'price_25000', '25000'],
    ['p100000', 'price_100000', '100000'],
    ['p500000', 'price_500000', '500000'],
  ]
  for (const [pack, price, credits] of packs) {
    const response = await callApi(app, env, 'POST', '/v1/billing/checkout', { token, body: { pack } })
    assert.equal(response.status, 200, pack)
    const form = stripe.calls.at(-1).form
    assert.equal(form.get('line_items[0][price]'), price)
    assert.equal(form.get('metadata[credits]'), credits)
    assert.equal(form.get('metadata[pack]'), pack)
  }
  assert.equal(stripe.calls.length, packs.length)
})

test('checkout rejects unknown packs and missing auth without calling Stripe', async () => {
  const store = new MemoryStore()
  const { token } = await seedKey(store, { credits: 10 })
  const stripe = makeStripeUpstream()
  const app = createApp({ store, fetch: stripe.fetch })

  const badPack = await callApi(app, stripeEnv(), 'POST', '/v1/billing/checkout', {
    token,
    body: { pack: 'p999' },
  })
  assert.equal(badPack.status, 400)
  assert.equal(badPack.body.error.code, 'invalid_pack')

  const unauthorized = await callApi(app, stripeEnv(), 'POST', '/v1/billing/checkout', {
    body: { pack: 'p5000' },
  })
  assert.equal(unauthorized.status, 401)

  const missingPrice = await callApi(app, stripeEnv({ STRIPE_PRICE_P5000: '' }), 'POST', '/v1/billing/checkout', {
    token,
    body: { pack: 'p5000' },
  })
  assert.equal(missingPrice.status, 500)
  assert.equal(missingPrice.body.error.code, 'stripe_error')

  assert.equal(stripe.calls.length, 0)
})

test('POST /stripe/webhook rejects invalid, stale, and missing signatures', async () => {
  const store = new MemoryStore()
  await seedKey(store, { credits: 10 })
  const app = createApp({ store, fetch: throwIfCalled })
  const env = stripeEnv()
  const event = completedEvent()
  const good = signedEvent(event)

  const wrongSecret = signedEvent(event, 'whsec_wrong')
  const invalid = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': wrongSecret.header },
    body: good.payload,
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_signature')

  const stale = signedEvent(event, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600)
  const staleResponse = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': stale.header },
    body: good.payload,
  })
  assert.equal(staleResponse.status, 400)
  assert.equal(staleResponse.body.error.code, 'invalid_signature')

  const missing = await callApi(app, env, 'POST', '/stripe/webhook', { body: good.payload })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'invalid_signature')

  assert.equal(store.accounts.get('user_seed').creditMicros, 10_000_000)
  assert.equal(store.stripeEvents.size, 0)
})

test('checkout.session.completed grants credits exactly once', async () => {
  const store = new MemoryStore()
  await seedKey(store, { credits: 10 })
  const app = createApp({ store, fetch: throwIfCalled })
  const env = stripeEnv()
  const event = completedEvent({ id: 'evt_once_1', sessionId: 'cs_once_1' })
  const signed = signedEvent(event)

  const first = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': signed.header },
    body: signed.payload,
  })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { received: true, granted: true })
  assert.equal(store.accounts.get('user_seed').creditMicros, 5_010_000_000)
  assert.equal(store.stripeEvents.size, 1)
  assert.deepEqual(
    store.ledger.map((entry) => [entry.kind, entry.amountMicros]),
    [['grant', 5_000_000_000]],
  )

  const duplicate = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': signed.header },
    body: signed.payload,
  })
  assert.equal(duplicate.status, 200)
  assert.deepEqual(duplicate.body, { received: true, granted: false })
  assert.equal(store.accounts.get('user_seed').creditMicros, 5_010_000_000)
  assert.equal(store.stripeEvents.size, 1)
  assert.equal(store.ledger.length, 1)
})

test('webhook ignores unrelated and unpaid events idempotently', async () => {
  const store = new MemoryStore()
  await seedKey(store, { credits: 10 })
  const app = createApp({ store, fetch: throwIfCalled })
  const env = stripeEnv()

  const unrelated = signedEvent({ id: 'evt_invoice', type: 'invoice.paid', data: { object: { id: 'in_1' } } })
  const unrelatedResponse = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': unrelated.header },
    body: unrelated.payload,
  })
  assert.equal(unrelatedResponse.status, 200)
  assert.deepEqual(unrelatedResponse.body, { received: true, ignored: true })

  const unpaid = signedEvent(completedEvent({ id: 'evt_unpaid', paymentStatus: 'unpaid' }))
  const unpaidResponse = await callApi(app, env, 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': unpaid.header },
    body: unpaid.payload,
  })
  assert.equal(unpaidResponse.status, 200)
  assert.deepEqual(unpaidResponse.body, { received: true, ignored: true })

  const mismatched = signedEvent(completedEvent({ id: 'evt_mismatch', credits: '9999' }))
  const originalWarn = console.warn
  console.warn = () => {}
  let mismatchedResponse
  try {
    mismatchedResponse = await callApi(app, env, 'POST', '/stripe/webhook', {
      headers: { 'stripe-signature': mismatched.header },
      body: mismatched.payload,
    })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(mismatchedResponse.status, 200)
  assert.deepEqual(mismatchedResponse.body, { received: true, ignored: true })

  assert.equal(store.accounts.get('user_seed').creditMicros, 10_000_000)
  assert.equal(store.stripeEvents.size, 0)
})

test('webhook is unavailable when STRIPE_WEBHOOK_SECRET is not configured', async () => {
  const store = new MemoryStore()
  const app = createApp({ store, fetch: throwIfCalled })
  const response = await callApi(app, makeEnv(), 'POST', '/stripe/webhook', {
    headers: { 'stripe-signature': 't=1,v1=abcd' },
    body: '{}',
  })
  assert.equal(response.status, 500)
  assert.equal(response.body.error.code, 'webhook_not_configured')
})
