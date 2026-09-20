/**
 * Public types for `@codebam/eval-jev-guardrails`.
 *
 * The package is an HTTP client for the hosted eval.seanbehan.ca service plus
 * the harness-specific glue that turns a blocked verdict into a real,
 * non-executing tool call.
 *
 * @module @codebam/eval-jev-guardrails/types
 */

/** Which side of an agent loop is being screened. */
export type EvalSide = 'input' | 'output' | 'observation' | 'action'

/** The service's final decision for a screened item. */
export type EvalAction = 'allow' | 'review' | 'block' | 'support'

/** How a hook behaves when the service cannot be reached. */
export type EvalFailMode = 'open' | 'review' | 'closed'

/** How a hook treats a `review` verdict. Default: `deny`. */
export type EvalReviewMode = 'deny' | 'allow'

/** One proposed tool call, as sent to `POST /v1/evaluate`. */
export interface EvalActionDescriptor {
  /** Harness tool name, e.g. `Bash`, `shell_exec`, `write_file`. */
  tool: string
  /** Raw tool arguments; kept as a JSON value so every harness can pass its own shape. */
  arguments?: unknown
  /** Working directory or workspace the call would run in. */
  workspace?: string
  /** Provider tool-call id, when the harness exposes one. */
  callID?: string
  /** Session id, when the harness exposes one. */
  sessionID?: string
  [key: string]: unknown
}

/** Token usage reported by the service for one evaluation. */
export interface EvalUsage {
  input_tokens?: number
  output_tokens?: number
  cost?: number
  [key: string]: unknown
}

/** The verdict object returned inside `POST /v1/evaluate`. */
export interface EvalVerdict {
  action: EvalAction
  side?: EvalSide
  kind?: string
  hazards?: Record<string, number>
  severity?: number
  reason?: string
  reasons?: string[]
  model?: string
  usage?: EvalUsage
  cached?: boolean
  degraded?: boolean
  error?: string
  [key: string]: unknown
}

/** Credit accounting returned by the service. */
export interface EvalCredits {
  remaining: number
  charged?: number
  total?: number
  [key: string]: unknown
}

/** `POST /v1/evaluate` response. */
export interface EvalEvaluation {
  verdict: EvalVerdict
  credits?: EvalCredits
  [key: string]: unknown
}

/** `POST /v1/systemone` request. Kept permissive so callers can pass library batteries verbatim. */
export interface EvalSystemOneRequest {
  state: unknown
  questions: Record<string, unknown>
  model?: string
  [key: string]: unknown
}

/** `POST /v1/systemone` response. */
export interface EvalSystemOneResponse {
  answers: Record<string, unknown>
  model?: string
  usage?: EvalUsage
  [key: string]: unknown
}

/** `GET /v1/credits` response. */
export interface EvalCreditsResponse extends EvalCredits {}

/** Credit packs purchasable through `eval-jev buy` / `POST /v1/billing/checkout`. */
export const EVAL_CREDIT_PACKS = ['p5000', 'p25000', 'p100000', 'p500000'] as const

/** One purchasable Stripe credit pack id. */
export type EvalCreditPack = (typeof EVAL_CREDIT_PACKS)[number]

/** Options for {@link EvalGuardrailsClient.checkout}. */
export interface EvalCheckoutOptions {
  /**
   * Optional Stripe promotion code to pre-apply (e.g. `SAVE10`). When
   * omitted, Stripe Checkout shows its promotion-code field by default.
   */
  promotionCode?: string
}

/** `POST /v1/billing/checkout` response: a hosted Stripe Checkout Session. */
export interface EvalCheckoutResponse {
  url: string
  id?: string
  [key: string]: unknown
}

/** `GET /v1/me` response. */
export interface EvalMeResponse {
  id?: string
  login?: string
  email?: string
  credits?: number
  [key: string]: unknown
}

/** Options accepted by {@link EvalGuardrailsClient}. */
export interface EvalClientOptions {
  /** Explicit key; otherwise `EVAL_API_KEY`, then the config file. */
  apiKey?: string
  /** Explicit base URL; otherwise `EVAL_BASE_URL`, then the config file, then the hosted default. */
  baseUrl?: string
  /** Override the config file path (defaults to `EVAL_CONFIG_PATH` or `~/.config/eval-jev/config.json`). */
  configPath?: string
  /** Per-request timeout in milliseconds. Default: `EVAL_TIMEOUT_MS` or 5000. */
  timeoutMs?: number
  /** Injectable fetch for tests. */
  fetch?: typeof globalThis.fetch
  /** Environment to read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Home directory used for config resolution; defaults to `os.homedir()`. */
  home?: string
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Value for the `User-Agent` header. */
  userAgent?: string
}

/** Where a resolved value came from, for `doctor` and debugging. */
export type EvalConfigSource = 'option' | 'env' | 'config' | 'default' | 'missing'

/** Fully resolved client configuration. */
export interface EvalResolvedConfig {
  apiKey: string | undefined
  baseUrl: string
  configPath: string
  apiKeySource: EvalConfigSource
  baseUrlSource: EvalConfigSource
  /** Raw parsed config-file content, when a readable file existed. */
  file: Record<string, unknown> | undefined
}

/** A model-facing outcome computed by the shared hook policy. */
export type HookDecision = 'allow' | 'block'

/** Result of applying review/fail policy to one action evaluation. */
export interface HookOutcome {
  decision: HookDecision
  /** Verdict returned by the service, when the request itself succeeded. */
  verdict?: EvalVerdict
  /** Model-facing block message. Present exactly when `decision === 'block'`. */
  reason?: string
  /** True when the outcome came from fail-mode handling rather than a service verdict. */
  degraded: boolean
  /** Error detail for a degraded outcome. */
  error?: string
}
