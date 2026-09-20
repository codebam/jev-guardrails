/**
 * Shared types for the hosted eval service.
 *
 * The Worker intentionally declares a tiny structural subset of Cloudflare's
 * D1 API instead of depending on `@cloudflare/workers-types`: the real D1
 * binding satisfies these shapes, and tests can supply an in-memory or SQLite
 * implementation without a build-time Cloudflare dependency.
 */
import type { FailMode, GuardSide, GuardVerdict } from '@codebam/jev-guardrails'

/** Credit classes. `guard_credits` evaluations are free. */
export type CreditPlan = 'standard' | 'guard_credits'

/** Ledger entry kinds recorded in `credit_ledger`. */
export type LedgerKind = 'grant' | 'reserve' | 'refund' | 'cache_hit' | 'adjustment'

/** Evaluation lifecycle states stored in `evaluations.status`. */
export type EvaluationStatus = 'pending' | 'complete' | 'cached' | 'degraded' | 'failed'

/** Minimal D1 result shape used by the service. */
export interface D1Result<T = unknown> {
  results?: T[]
  success: boolean
  meta?: {
    changes?: number
    duration?: number
    last_row_id?: number
  }
}

/** Minimal D1 prepared-statement shape used by the service. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
}

/** Minimal D1 database shape used by the service. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
}

/** Worker bindings and secrets. */
export interface Env {
  /** D1 database binding. */
  DB: D1Database
  /** OpenRouter API key that pays for Jev Decisions calls. */
  OPENROUTER_API_KEY: string
  /** Bootstrap token for `POST /admin/keys`. */
  EVAL_ADMIN_TOKEN?: string
  /** OpenRouter model or alias. Defaults to `~typesafe/jev-latest`. */
  OPENROUTER_MODEL?: string
  /** Optional OpenRouter endpoint/root override (tests, proxies). */
  OPENROUTER_BASE_URL?: string
  /** Upstream request timeout in milliseconds. Defaults to 15000. */
  OPENROUTER_TIMEOUT_MS?: string
  /** Service-side response-cache TTL in seconds. Defaults to 3600. */
  EVAL_CACHE_TTL_SECONDS?: string
}

/** An account as stored in `users`. */
export interface Account {
  id: string
  email: string | null
  displayName: string | null
  githubLogin: string | null
  plan: CreditPlan
  creditMicros: number
  createdAt: number
  updatedAt: number
}

/** An API key record as stored in `api_keys` (never the plaintext token). */
export interface ApiKeyRecord {
  id: string
  userId: string
  name: string | null
  keyPrefix: string
  keyHash: string
  /** Per-key override; when null the owning account's plan applies. */
  plan: CreditPlan | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

/** Result of looking up a bearer token by its SHA-256 hash. */
export interface AuthRecord {
  key: ApiKeyRecord
  account: Account
}

/** Input for creating an account. */
export interface CreateAccountInput {
  id: string
  email: string | null
  displayName: string | null
  plan: CreditPlan
  now: number
}

/** Input for creating an API key. */
export interface CreateApiKeyInput {
  id: string
  userId: string
  name: string | null
  keyPrefix: string
  keyHash: string
  plan: CreditPlan | null
  now: number
}

/** Input for one unconditional ledger entry (grant, refund, adjustment). */
export interface LedgerEntryInput {
  userId: string
  /** Signed amount: positive credits the account, negative debits it. */
  amountMicros: number
  kind: LedgerKind
  evaluationId?: string
  note?: string
  now: number
}

/** Input for a conditional debit; `amountMicros` is positive. */
export interface ReserveInput {
  userId: string
  /** Positive number of micro-credits to remove. */
  amountMicros: number
  kind: 'reserve' | 'cache_hit'
  evaluationId?: string
  note?: string
  now: number
}

/** Conditional debit result. */
export type DebitResult =
  | { ok: true; balanceMicros: number }
  | { ok: false; balanceMicros: number }

/** Input for starting an evaluation audit row. */
export interface StartEvaluationInput {
  id: string
  userId: string
  apiKeyId: string
  side: GuardSide
  batteryId: string
  model: string
  requestHash: string
  now: number
}

/** Input for completing an evaluation audit row. */
export interface FinishEvaluationInput {
  id: string
  status: EvaluationStatus
  now: number
  verdictJson?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  costMicros?: number
  degraded?: boolean
  cachedHit?: boolean
  error?: string
}

/** A cached evaluation returned by the store. */
export interface CachedEvaluation {
  id: string
  verdictJson: string
  model: string | null
  createdAt: number
}

/** Persistence contract used by the Worker (D1 in production, memory in tests). */
export interface EvalStore {
  findApiKeyByHash(keyHash: string): Promise<AuthRecord | null>
  touchApiKey(apiKeyId: string, at: number): Promise<void>
  createAccount(input: CreateAccountInput): Promise<Account>
  findAccountByEmail(email: string): Promise<Account | null>
  getAccount(userId: string): Promise<Account | null>
  createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord>
  /** Grant/refund/adjust credits with a ledger row. */
  applyLedgerEntry(input: LedgerEntryInput): Promise<{ balanceMicros: number }>
  /** Atomically debit credits when the balance covers it. */
  reserveCredits(input: ReserveInput): Promise<DebitResult>
  startEvaluation(input: StartEvaluationInput): Promise<void>
  finishEvaluation(input: FinishEvaluationInput): Promise<void>
  findCachedEvaluation(input: {
    requestHash: string
    now: number
    ttlMs: number
  }): Promise<CachedEvaluation | null>
}

/** A verdict plus service-level metadata returned by `/v1/evaluate`. */
export type ApiVerdict = GuardVerdict & {
  /** Which failure mode selected a degraded action. */
  failMode?: FailMode
}

/** Response body of `POST /v1/evaluate`. */
export interface EvaluateResponse {
  verdict: ApiVerdict
  credits: {
    remaining: number
    charged: number
    plan: CreditPlan
  }
}

/** Response body of `GET /v1/credits`. */
export interface CreditsResponse {
  remaining: number
  plan: CreditPlan
  guardCredits: boolean
}

/** Response body of `GET /v1/me`. */
export interface MeResponse {
  user: {
    id: string
    email: string | null
    displayName: string | null
    githubLogin: string | null
    plan: CreditPlan
    createdAt: number
  }
  credits: CreditsResponse
}

/** Response body of `POST /admin/keys`. */
export interface AdminKeyResponse {
  apiKey: string
  key: {
    id: string
    name: string | null
    prefix: string
    plan: CreditPlan
    createdAt: number
  }
  user: MeResponse['user']
  credits: CreditsResponse
}

/** Standard error envelope. */
export interface ErrorResponse {
  error: {
    code: string
    message: string
  }
}
