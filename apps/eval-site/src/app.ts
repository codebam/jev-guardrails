/**
 * The hosted eval service Worker.
 *
 * `createApp` is a small factory so tests can inject an in-memory store, a
 * fake clock, and a mocked upstream `fetch`; `src/index.ts` exports the
 * production instance in Cloudflare's module-worker format.
 */
import type { Battery, GuardSide, GuardVerdict } from '@codebam/jev-guardrails'
import { constantTimeEqual, generateApiKey, newId, sha256Hex } from './crypto.js'
import { D1Store } from './d1-store.js'
import { createGithubClient, GithubError, resolveGithubClientId } from './github.js'
import type { GithubClient } from './github.js'
import {
  createDecisionsCaller,
  isRecord,
  isSupportedJevModel,
  providerErrorMessage,
  resolveModel,
  validateAnswers,
} from './provider.js'
import type { DecisionsCaller } from './provider.js'
import {
  createStripeClient,
  isStripePack,
  parseStripeEvent,
  STRIPE_PACKS,
  StripeError,
  verifyStripeSignature,
} from './stripe.js'
import type { StripeClient } from './stripe.js'
import {
  allBatteries,
  batteryForSide,
  buildActionState,
  buildGuardVerdict,
  degradedVerdict,
  isGuardSide,
  MAX_STATE_CHARS,
  measureState,
  questionsHash,
  requestHash,
} from './verdict.js'
import type {
  Account,
  AdminKeyResponse,
  ApiKeyRecord,
  CachedEvaluation,
  CreditPlan,
  Env,
  EvalStore,
  EvaluateResponse,
  MeResponse,
} from './types.js'

/** One credit in micro-credits. */
export const CREDIT_MICROS = 1_000_000
/** Contract price for a service-side cache hit. */
export const CACHE_HIT_MICROS = 100_000
/** Service-side cache lifetime. */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
/** Credits granted when an admin bootstraps a brand-new account. */
export const DEFAULT_INITIAL_CREDITS = 10_000

/** Factory options; every one is an injection point for tests. */
export interface AppOptions {
  /** Override persistence (tests use an in-memory store). */
  store?: EvalStore
  /** Upstream fetch implementation. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
  /** Override the service-side cache TTL. Defaults to one hour. */
  cacheTtlMs?: number
}

/** Minimal Worker shape. */
export interface EvalWorker {
  fetch(request: Request, env: Env): Promise<Response>
}

/** HTTP error mapped to the standard JSON error envelope. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Build the Worker. */
export function createApp(options: AppOptions = {}): EvalWorker {
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const decisions = createDecisionsCaller(fetchImpl)
  const github = createGithubClient(fetchImpl)
  const stripe = createStripeClient(fetchImpl)
  const cacheTtlOverride = options.cacheTtlMs

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const store = options.store ?? storeFor(env)
        const context: RequestContext = { request, env, store, decisions, github, stripe, now }
        const path = normalizePath(new URL(request.url).pathname)
        switch (path) {
          case '/v1/evaluate':
            return request.method === 'POST'
              ? await handleEvaluate({
                  ...context,
                  cacheTtlMs: cacheTtlOverride ?? cacheTtlFromEnv(env),
                })
              : methodNotAllowed('POST')
          case '/v1/systemone':
            return request.method === 'POST' ? await handleSystemOne(context) : methodNotAllowed('POST')
          case '/v1/me':
            return request.method === 'GET' ? await handleMe(request, env, store, now) : methodNotAllowed('GET')
          case '/v1/credits':
            return request.method === 'GET'
              ? await handleCredits(request, env, store, now)
              : methodNotAllowed('GET')
          case '/admin/keys':
            return request.method === 'POST'
              ? await handleAdminKeys(request, env, store, now)
              : methodNotAllowed('POST')
          case '/v1/auth/device':
            return request.method === 'POST' ? await handleGithubDeviceStart(context) : methodNotAllowed('POST')
          case '/v1/auth/device/token':
            return request.method === 'POST' ? await handleGithubDeviceToken(context) : methodNotAllowed('POST')
          case '/v1/billing/checkout':
            return request.method === 'POST' ? await handleCheckout(context) : methodNotAllowed('POST')
          case '/stripe/webhook':
            return request.method === 'POST' ? await handleStripeWebhook(context) : methodNotAllowed('POST')
          default:
            return errorResponse(404, 'not_found', `No route for ${path}.`)
        }
      } catch (error) {
        if (error instanceof HttpError) {
          return errorResponse(error.status, error.code, error.message)
        }
        if (error instanceof GithubError) {
          const status = error.status >= 400 && error.status <= 599 ? error.status : 502
          return errorResponse(status, 'github_error', error.message)
        }
        if (error instanceof StripeError) {
          const status = error.status >= 400 && error.status <= 599 ? error.status : 502
          return errorResponse(status, 'stripe_error', error.message)
        }
        console.error('eval-site: unhandled error', error)
        return errorResponse(500, 'internal_error', 'The service hit an unexpected error.')
      }
    },
  }
}

function cacheTtlFromEnv(env: Env): number {
  const seconds = Number(env.EVAL_CACHE_TTL_SECONDS)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_CACHE_TTL_MS
  return Math.min(Math.floor(seconds * 1000), 24 * 60 * 60 * 1000)
}

function storeFor(env: Env): EvalStore {
  if (env.DB === undefined || env.DB === null) {
    throw new HttpError(500, 'service_misconfigured', 'The D1 binding "DB" is not configured.')
  }
  return new D1Store(env.DB)
}

interface RequestContext {
  request: Request
  env: Env
  store: EvalStore
  decisions: DecisionsCaller
  github: GithubClient
  stripe: StripeClient
  now: () => number
}

interface AuthContext {
  account: Account
  key: ApiKeyRecord
  plan: CreditPlan
}

async function authenticate(request: Request, store: EvalStore, at: number): Promise<AuthContext> {
  const token = parseBearer(request.headers.get('authorization'))
  if (token === null || !token.startsWith('eval_')) {
    throw new HttpError(401, 'unauthorized', 'Provide an eval_ API key as Authorization: Bearer <token>.')
  }
  const record = await store.findApiKeyByHash(await sha256Hex(token))
  if (record === null || record.key.revokedAt !== null) {
    throw new HttpError(401, 'unauthorized', 'That API key is not valid.')
  }
  // Usage tracking is best-effort: a failed timestamp must not fail the call.
  try {
    await store.touchApiKey(record.key.id, at)
  } catch (error) {
    console.warn('eval-site: could not update key last_used_at', error)
  }
  return {
    account: record.account,
    key: record.key,
    plan: record.key.plan ?? record.account.plan,
  }
}

async function handleEvaluate(context: RequestContext & { cacheTtlMs: number }): Promise<Response> {
  const { request, env, store, decisions, now, cacheTtlMs } = context
  const auth = await authenticate(request, store, now())
  const body = await readJsonObject(request)

  if (!isGuardSide(body.side)) {
    throw new HttpError(400, 'invalid_side', 'side must be one of input, output, observation, or action.')
  }
  const side = body.side
  const battery = batteryForSide(side)

  let state: unknown
  if (side === 'action') {
    if (!isRecord(body.action)) {
      throw new HttpError(400, 'invalid_action', 'side "action" requires an action object with a tool and arguments.')
    }
    try {
      state = buildActionState(body.action)
    } catch (error) {
      throw new HttpError(400, 'invalid_action', providerErrorMessage(error))
    }
  } else {
    if (body.state === undefined || body.state === null) {
      throw new HttpError(400, 'state_required', 'state is required and must be text or a JSON value.')
    }
    state = body.state
  }

  const stateChars = measureState(state)
  if (stateChars > MAX_STATE_CHARS) {
    throw new HttpError(413, 'state_too_large', `state is ${stateChars} characters; the limit is ${MAX_STATE_CHARS}.`)
  }

  const model = resolveModel(env)
  const hash = await requestHash(model, state, battery.questions)
  const at = now()
  const cached = await store.findCachedEvaluation({ requestHash: hash, now: at, ttlMs: cacheTtlMs })
  const cachedVerdict = cached === null ? null : parseCachedVerdict(cached)
  if (cached !== null && cachedVerdict !== null) {
    return await serveCacheHit({ auth, cached, verdict: cachedVerdict, hash, store, now })
  }
  return await runEvaluation({ auth, env, store, decisions, now, side, battery, state, model, hash })
}

async function serveCacheHit(input: {
  auth: AuthContext
  cached: CachedEvaluation
  verdict: GuardVerdict
  hash: string
  store: EvalStore
  now: () => number
}): Promise<Response> {
  const { auth, cached, verdict, hash, store, now } = input
  const chargeMicros = auth.plan === 'guard_credits' ? 0 : CACHE_HIT_MICROS
  const at = now()
  let remaining = auth.account.creditMicros
  if (chargeMicros > 0) {
    const debit = await store.reserveCredits({
      userId: auth.account.id,
      amountMicros: chargeMicros,
      kind: 'cache_hit',
      evaluationId: cached.id,
      note: 'service-side cache hit',
      now: at,
    })
    if (!debit.ok) {
      throw new HttpError(
        402,
        'insufficient_credits',
        `A cache hit costs 0.1 credits but only ${formatCredits(debit.balanceMicros)} remain.`,
      )
    }
    remaining = debit.balanceMicros
  } else {
    const account = await store.getAccount(auth.account.id)
    if (account !== null) remaining = account.creditMicros
  }

  const responseVerdict: GuardVerdict = { ...verdict, cached: true }
  await bestEffort(async () => {
    const id = newId('ev')
    await store.startEvaluation({
      id,
      userId: auth.account.id,
      apiKeyId: auth.key.id,
      side: responseVerdict.side,
      batteryId: batteryForSide(responseVerdict.side).id,
      model: cached.model ?? 'cached',
      requestHash: hash,
      now: at,
    })
    await store.finishEvaluation({
      id,
      status: 'cached',
      now: now(),
      verdictJson: JSON.stringify(responseVerdict),
      ...(cached.model !== null ? { model: cached.model } : {}),
      degraded: false,
      cachedHit: true,
    })
  })
  return json(
    {
      verdict: responseVerdict,
      credits: creditsBody(remaining, chargeMicros, auth.plan),
    } satisfies EvaluateResponse,
    200,
  )
}

async function runEvaluation(input: {
  auth: AuthContext
  env: Env
  store: EvalStore
  decisions: DecisionsCaller
  now: () => number
  side: GuardSide
  battery: Battery
  state: unknown
  model: string
  hash: string
}): Promise<Response> {
  const { auth, env, store, decisions, now, side, battery, state, model, hash } = input
  const evaluationId = newId('ev')
  const reservedMicros = auth.plan === 'guard_credits' ? 0 : CREDIT_MICROS
  const at = now()
  let remaining = auth.account.creditMicros
  if (reservedMicros > 0) {
    const debit = await store.reserveCredits({
      userId: auth.account.id,
      amountMicros: reservedMicros,
      kind: 'reserve',
      evaluationId,
      note: `evaluate ${side}`,
      now: at,
    })
    if (!debit.ok) {
      throw new HttpError(
        402,
        'insufficient_credits',
        `This key has ${formatCredits(debit.balanceMicros)} credits remaining; one credit is required.`,
      )
    }
    remaining = debit.balanceMicros
  } else {
    const account = await store.getAccount(auth.account.id)
    if (account !== null) remaining = account.creditMicros
  }

  try {
    await store.startEvaluation({
      id: evaluationId,
      userId: auth.account.id,
      apiKeyId: auth.key.id,
      side,
      batteryId: battery.id,
      model,
      requestHash: hash,
      now: at,
    })
  } catch (error) {
    console.error('eval-site: could not create evaluation row', error)
    if (reservedMicros > 0) {
      await bestEffort(() =>
        store.applyLedgerEntry({
          userId: auth.account.id,
          amountMicros: reservedMicros,
          kind: 'refund',
          evaluationId,
          note: 'refund: evaluation row could not be created',
          now: now(),
        }),
      )
    }
    throw new HttpError(500, 'storage_error', 'The service could not start the evaluation.')
  }

  let result
  try {
    result = await decisions({ model, state, questions: battery.questions }, env)
    validateAnswers(battery.questions, result.answers)
  } catch (error) {
    const message = providerErrorMessage(error)
    if (reservedMicros > 0) {
      const refunded = await store.applyLedgerEntry({
        userId: auth.account.id,
        amountMicros: reservedMicros,
        kind: 'refund',
        evaluationId,
        note: `refund: ${message}`,
        now: now(),
      })
      remaining = refunded.balanceMicros
    }
    const verdict = degradedVerdict(side, battery, error)
    await bestEffort(() =>
      store.finishEvaluation({
        id: evaluationId,
        status: 'degraded',
        now: now(),
        degraded: true,
        error: message,
      }),
    )
    return json(
      { verdict, credits: creditsBody(remaining, 0, auth.plan) } satisfies EvaluateResponse,
      200,
    )
  }

  const verdict = buildGuardVerdict({
    side,
    battery,
    answers: result.answers,
    model: result.model,
    usage: result.usage,
    cached: false,
  })
  await bestEffort(() =>
    store.finishEvaluation({
      id: evaluationId,
      status: 'complete',
      now: now(),
      verdictJson: JSON.stringify(verdict),
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      ...(result.usage.cost !== undefined ? { costMicros: Math.round(result.usage.cost * CREDIT_MICROS) } : {}),
      degraded: false,
      cachedHit: false,
    }),
  )
  return json(
    { verdict, credits: creditsBody(remaining, reservedMicros, auth.plan) } satisfies EvaluateResponse,
    200,
  )
}

async function handleSystemOne(context: RequestContext): Promise<Response> {
  const { request, env, store, decisions, now } = context
  const auth = await authenticate(request, store, now())
  const body = await readJsonObject(request)

  if (body.state === undefined || body.state === null) {
    throw new HttpError(400, 'state_required', 'state is required and must be text or a JSON value.')
  }
  const stateChars = measureState(body.state)
  if (stateChars > MAX_STATE_CHARS) {
    throw new HttpError(413, 'state_too_large', `state is ${stateChars} characters; the limit is ${MAX_STATE_CHARS}.`)
  }
  if (!isRecord(body.questions) || Object.keys(body.questions).length === 0) {
    throw new HttpError(400, 'invalid_questions', 'questions must be a non-empty object of Jev questions.')
  }
  const battery = await findBattery(body.questions)
  if (battery === null) {
    throw new HttpError(
      400,
      'unknown_battery_questions',
      'Only question sets whose canonical hash matches a built-in guardrails battery are accepted.',
    )
  }

  let model = resolveModel(env)
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string') {
      throw new HttpError(400, 'invalid_model', 'model must be a string.')
    }
    model = resolveModel(env, body.model)
    if (!isSupportedJevModel(model)) {
      throw new HttpError(400, 'unsupported_model', 'Only TypeSafe Jev models are available on this service.')
    }
  }

  const evaluationId = newId('eval')
  const at = now()
  let reserved = false
  if (auth.plan !== 'guard_credits') {
    const debit = await store.reserveCredits({
      userId: auth.account.id,
      amountMicros: CREDIT_MICROS,
      kind: 'reserve',
      evaluationId,
      note: 'systemone evaluation',
      now: at,
    })
    if (!debit.ok) {
      throw new HttpError(
        402,
        'insufficient_credits',
        `This evaluation costs 1 credit but only ${formatCredits(debit.balanceMicros)} remain.`,
      )
    }
    reserved = true
  }

  try {
    const result = await decisions({ model, state: body.state, questions: battery.questions }, env)
    validateAnswers(battery.questions, result.answers)
    return json({ model: result.model, answers: result.answers, usage: result.usage }, 200)
  } catch (error) {
    if (reserved) {
      try {
        await store.applyLedgerEntry({
          userId: auth.account.id,
          amountMicros: CREDIT_MICROS,
          kind: 'refund',
          evaluationId,
          note: 'systemone provider failure refund',
          now: now(),
        })
      } catch (refundError) {
        console.warn('eval-site: could not refund failed systemone evaluation', refundError)
      }
    }
    console.warn('eval-site: systemone provider failure', error)
    throw new HttpError(502, 'provider_error', `Jev is unavailable: ${providerErrorMessage(error)}`)
  }
}

async function handleMe(request: Request, env: Env, store: EvalStore, now: () => number): Promise<Response> {
  const auth = await authenticate(request, store, now())
  const account = (await store.getAccount(auth.account.id)) ?? auth.account
  return json(
    {
      user: userBody(account, auth.plan),
      credits: creditsDto(account.creditMicros, auth.plan),
    } satisfies MeResponse,
    200,
  )
}

async function handleCredits(request: Request, env: Env, store: EvalStore, now: () => number): Promise<Response> {
  const auth = await authenticate(request, store, now())
  const account = (await store.getAccount(auth.account.id)) ?? auth.account
  return json(creditsDto(account.creditMicros, auth.plan), 200)
}

async function handleAdminKeys(request: Request, env: Env, store: EvalStore, now: () => number): Promise<Response> {
  const configured = env.EVAL_ADMIN_TOKEN
  if (configured === undefined || configured.length === 0) {
    throw new HttpError(500, 'admin_not_configured', 'EVAL_ADMIN_TOKEN is not configured.')
  }
  const presented = parseBearer(request.headers.get('authorization'))
  if (presented === null || !(await constantTimeEqual(presented, configured))) {
    throw new HttpError(401, 'unauthorized', 'A valid admin bootstrap token is required.')
  }

  const body = await readJsonObject(request)
  const userId = optionalString(body.userId)
  const email = optionalString(body.email)?.toLowerCase() ?? null
  const displayName = optionalString(body.displayName) ?? null
  const keyName = optionalString(body.name) ?? null
  const plan = parsePlan(body.plan)
  const initialCredits = parseInitialCredits(body.initialCredits)

  let account: Account | null = null
  let created = false
  if (userId !== undefined) {
    account = await store.getAccount(userId)
    if (account === null) throw new HttpError(404, 'user_not_found', `No account with id ${userId}.`)
  } else if (email !== null) {
    account = await store.findAccountByEmail(email)
    if (account === null) {
      account = await store.createAccount({
        id: newId('user'),
        email,
        displayName,
        plan: plan ?? 'standard',
        now: now(),
      })
      created = true
    }
  } else {
    account = await store.createAccount({
      id: newId('user'),
      email: null,
      displayName,
      plan: plan ?? 'standard',
      now: now(),
    })
    created = true
  }

  const grant = initialCredits ?? (created ? DEFAULT_INITIAL_CREDITS : 0)
  if (grant > 0) {
    const result = await store.applyLedgerEntry({
      userId: account.id,
      amountMicros: creditsToMicros(grant),
      kind: 'grant',
      note: created ? 'initial account grant' : 'admin credit grant',
      now: now(),
    })
    account = { ...account, creditMicros: result.balanceMicros, updatedAt: now() }
  }

  const { token, prefix, hashPromise } = generateApiKey()
  const key = await store.createApiKey({
    id: newId('key'),
    userId: account.id,
    name: keyName,
    keyPrefix: prefix,
    keyHash: await hashPromise,
    plan,
    now: now(),
  })
  const effectivePlan = plan ?? account.plan
  const response: AdminKeyResponse = {
    apiKey: token,
    key: {
      id: key.id,
      name: key.name,
      prefix: key.keyPrefix,
      plan: effectivePlan,
      createdAt: key.createdAt,
    },
    user: userBody(account, effectivePlan),
    credits: creditsDto(account.creditMicros, effectivePlan),
  }
  return json(response, 201)
}

async function handleGithubDeviceStart(context: RequestContext): Promise<Response> {
  const { request, env, github } = context
  const body = await readJsonObject(request)
  const clientId = resolveGithubClientOrThrow(env, body.client_id)
  const scope = optionalString(body.scope)
  const payload = await github.startDevice(clientId, scope)
  return json(payload, 200)
}

async function handleGithubDeviceToken(context: RequestContext): Promise<Response> {
  const { request, env, store, github, now } = context
  const body = await readJsonObject(request)
  const clientId = resolveGithubClientOrThrow(env, body.client_id)
  const deviceCode = requiredString(body.device_code, 'device_code')
  const grantType = optionalString(body.grant_type) ?? 'urn:ietf:params:oauth:grant-type:device_code'

  const exchange = await github.exchangeDeviceCode({ clientId, deviceCode, grantType })
  // Polling states are returned verbatim with HTTP 200 so the CLI keeps polling.
  if (exchange.oauthError !== null) return json(exchange.oauthError, 200)
  if (exchange.accessToken === null) {
    throw new HttpError(502, 'github_error', 'GitHub token exchange returned no access token.')
  }

  const identity = await github.fetchIdentity(exchange.accessToken)
  let account = await store.findAccountByGithubId(identity.githubId)
  let created = false
  if (account === null) {
    // Never steal an existing account by email; a verified GitHub email that
    // is already attached elsewhere is dropped so github_id stays the key.
    let email = identity.email
    if (email !== null && (await store.findAccountByEmail(email)) !== null) email = null
    account = await store.createAccount({
      id: newId('user'),
      email,
      displayName: identity.displayName,
      githubId: identity.githubId,
      githubLogin: identity.login,
      plan: 'standard',
      now: now(),
    })
    created = true
  }

  if (created) {
    const freeCredits = freeCreditsFromEnv(env)
    if (freeCredits > 0) {
      const granted = await store.applyLedgerEntry({
        userId: account.id,
        amountMicros: creditsToMicros(freeCredits),
        kind: 'grant',
        note: 'GitHub signup free credits',
        now: now(),
      })
      account = { ...account, creditMicros: granted.balanceMicros }
    }
  }

  const { token, prefix, hashPromise } = generateApiKey()
  await store.createApiKey({
    id: newId('key'),
    userId: account.id,
    name: `github:${identity.login}`,
    keyPrefix: prefix,
    keyHash: await hashPromise,
    plan: null,
    now: now(),
  })
  return json(
    { apiKey: token, login: identity.login, credits: account.creditMicros / CREDIT_MICROS },
    200,
  )
}

async function handleCheckout(context: RequestContext): Promise<Response> {
  const { request, env, store, stripe, now } = context
  const auth = await authenticate(request, store, now())
  const body = await readJsonObject(request)
  if (!isStripePack(body.pack)) {
    throw new HttpError(400, 'invalid_pack', 'pack must be one of p5000, p25000, p100000, p500000.')
  }
  const session = await stripe.createCheckoutSession(env, { userId: auth.account.id, pack: body.pack })
  return json({ url: session.url, id: session.id }, 200)
}

async function handleStripeWebhook(context: RequestContext): Promise<Response> {
  const { request, env, store, now } = context
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim()
  if (secret === undefined || secret.length === 0) {
    throw new HttpError(500, 'webhook_not_configured', 'STRIPE_WEBHOOK_SECRET is not configured.')
  }
  const rawBody = await request.text()
  if (rawBody.length === 0) {
    throw new HttpError(400, 'invalid_payload', 'Stripe webhook body is empty.')
  }
  const valid = await verifyStripeSignature({
    secret,
    header: request.headers.get('stripe-signature'),
    payload: rawBody,
    nowSeconds: Math.floor(now() / 1000),
  })
  if (!valid) {
    throw new HttpError(400, 'invalid_signature', 'Stripe signature verification failed.')
  }

  const event = parseStripeEvent(rawBody)
  if (event === null) {
    throw new HttpError(400, 'invalid_payload', 'Could not parse the Stripe event.')
  }
  if (event.type !== 'checkout.session.completed') {
    return json({ received: true, ignored: true }, 200)
  }
  const paymentStatus = event.object.payment_status
  if (typeof paymentStatus === 'string' && paymentStatus !== 'paid') {
    return json({ received: true, ignored: true }, 200)
  }

  const metadata = isRecord(event.object.metadata) ? event.object.metadata : null
  const userId = metadata !== null && typeof metadata.userId === 'string' ? metadata.userId : null
  const credits = metadata === null ? null : parseStripeCredits(metadata.credits, metadata.pack)
  if (userId === null || credits === null) {
    console.warn(`eval-site: ignoring Stripe event ${event.id} without usable metadata`)
    return json({ received: true, ignored: true }, 200)
  }
  const account = await store.getAccount(userId)
  if (account === null) {
    console.warn(`eval-site: ignoring Stripe event ${event.id} for unknown user`)
    return json({ received: true, ignored: true }, 200)
  }

  const sessionId = typeof event.object.id === 'string' ? event.object.id : null
  const pack = isStripePack(metadata?.pack) ? metadata.pack : 'unknown'
  const result = await store.processStripeEvent({
    eventId: event.id,
    eventType: event.type,
    sessionId,
    userId,
    creditsMicros: creditsToMicros(credits),
    note: `Stripe credit pack ${pack}`,
    now: now(),
  })
  return json({ received: true, granted: result.granted }, 200)
}

function resolveGithubClientOrThrow(env: Env, requested: unknown): string {
  const resolved = resolveGithubClientId(env, requested)
  if (resolved.error === null) return resolved.clientId
  if (resolved.error.includes('not configured')) {
    throw new HttpError(500, 'github_not_configured', resolved.error)
  }
  throw new HttpError(400, 'invalid_client_id', resolved.error)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'invalid_body', `${field} is required.`)
  }
  return value.trim()
}

function freeCreditsFromEnv(env: Env): number {
  const raw = env.EVAL_FREE_CREDITS?.trim()
  if (raw === undefined || raw.length === 0) return 250
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 250
  return Math.min(parsed, 1_000_000)
}

function parseStripeCredits(creditsValue: unknown, packValue: unknown): number | null {
  const credits =
    typeof creditsValue === 'string' || typeof creditsValue === 'number' ? Number(creditsValue) : Number.NaN
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1_000_000) return null
  if (!isStripePack(packValue)) return null
  if (STRIPE_PACKS[packValue] !== credits) return null
  return credits
}

let batteryHashIndex: Promise<Map<string, Battery>> | undefined

async function findBattery(questions: Record<string, unknown>): Promise<Battery | null> {
  const hash = await questionsHash(questions)
  batteryHashIndex ??= (async () => {
    const index = new Map<string, Battery>()
    for (const battery of allBatteries()) index.set(await questionsHash(battery.questions), battery)
    return index
  })()
  return (await batteryHashIndex).get(hash) ?? null
}

function parseCachedVerdict(cached: CachedEvaluation): GuardVerdict | null {
  try {
    const parsed: unknown = JSON.parse(cached.verdictJson)
    if (!isRecord(parsed) || typeof parsed.action !== 'string' || typeof parsed.side !== 'string') return null
    return parsed as unknown as GuardVerdict
  } catch {
    return null
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new HttpError(400, 'invalid_json', 'Could not read the request body.')
  }
  if (text.trim().length === 0) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.')
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.')
  }
  return parsed
}

function parseBearer(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return null
  const token = match[1]?.trim() ?? ''
  return token.length > 0 ? token : null
}

function parsePlan(value: unknown): CreditPlan | null {
  if (value === undefined || value === null || value === '') return null
  if (value === 'standard' || value === 'guard_credits') return value
  throw new HttpError(400, 'invalid_plan', 'plan must be "standard" or "guard_credits".')
}

function parseInitialCredits(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new HttpError(400, 'invalid_initial_credits', 'initialCredits must be between 0 and 1,000,000.')
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '')
  return pathname
}

function creditsToMicros(credits: number): number {
  return Math.round(credits * CREDIT_MICROS)
}

function formatCredits(micros: number): string {
  return (micros / CREDIT_MICROS).toFixed(2)
}

function creditsBody(
  remainingMicros: number,
  chargedMicros: number,
  plan: CreditPlan,
): EvaluateResponse['credits'] {
  return {
    remaining: remainingMicros / CREDIT_MICROS,
    charged: chargedMicros / CREDIT_MICROS,
    plan,
  }
}

function creditsDto(remainingMicros: number, plan: CreditPlan) {
  return {
    remaining: remainingMicros / CREDIT_MICROS,
    plan,
    guardCredits: plan === 'guard_credits',
  }
}

function userBody(account: Account, plan: CreditPlan): MeResponse['user'] {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    githubLogin: account.githubLogin,
    plan,
    createdAt: account.createdAt,
  }
}

function methodNotAllowed(allow: string): Response {
  const response = errorResponse(405, 'method_not_allowed', `Use ${allow} for this route.`)
  response.headers.set('allow', allow)
  return response
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    console.warn('eval-site: best-effort write failed', error)
  }
}

