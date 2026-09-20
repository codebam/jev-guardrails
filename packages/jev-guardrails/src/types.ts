/**
 * Public types for `@codebam/jev-guardrails`.
 *
 * The library keeps the model call, the policy, and the action separate:
 *
 * 1. a *battery* is a fixed set of typed Jev questions plus the hazard names
 *    its answers carry;
 * 2. a *policy* maps hazard probabilities and a severity score to one of four
 *    product actions (`allow`, `review`, `block`, `support`);
 * 3. the caller decides what those actions mean (retry, ask, deny, escalate).
 *
 * Nothing here imports the DeepSeek Harness; the library is framework
 * agnostic and the dsh plugin is only one consumer.
 *
 * @module @codebam/jev-guardrails/types
 */
import type {
  Fetch,
  JsonValue,
  Logger,
  Questions,
  RequestOptions,
  RetryPolicy,
  SystemOneRequest,
  SystemOneResult,
} from '@typesafe-ai/sdk'

/** Which side of an LLM call is being screened. */
export type GuardSide = 'input' | 'output' | 'observation' | 'action'

/**
 * Which service answers Jev questions.
 *
 * - `typesafe`: TypeSafe's own `POST /v1/systemone` endpoint through
 *   `@typesafe-ai/sdk`;
 * - `openrouter`: OpenRouter's Decisions API (`POST /api/alpha/decisions`);
 * - `hosted`: the paid `eval.seanbehan.ca` service (SystemOne-shaped proxy
 *   with API keys and credits).
 */
export type JevProvider = 'typesafe' | 'openrouter' | 'hosted'

/** Token usage plus OpenRouter's estimated cost when reported. */
export interface GuardUsage {
  input_tokens: number
  output_tokens: number
  /** Estimated request cost in USD, reported by OpenRouter. */
  cost?: number
}

/** What the caller should do with a screened item. */
export type GuardAction = 'allow' | 'review' | 'block' | 'support'

/** A short label used in model-facing and human-facing reasons. */
export type GuardKind = 'prompt' | 'response' | 'observation' | 'action'

/** How the library degrades when the Jev request fails. */
export type FailMode = 'open' | 'review' | 'closed'

/** Minimal transport contract; `@typesafe-ai/sdk`'s `TypeSafeClient` satisfies it. */
export interface JevTransport {
  systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Q>>
}

/** In-memory response cache settings. */
export interface CacheSettings {
  /** How long a cached answer stays valid, in milliseconds. Default: 1 hour. */
  ttlMs: number
  /** Maximum cached answers retained. Default: 500. */
  maxEntries: number
}

/** One named secret-redaction rule. */
export interface RedactionPattern {
  /** Stable rule name reported in the replacement marker. */
  name: string
  /** Pattern to replace. Use a global flag when more than one match is expected. */
  pattern: RegExp
  /**
   * Replacement text or callback. When omitted, matches become
   * `[REDACTED:${name}]`.
   */
  replacement?: string | ((match: string, ...groups: string[]) => string)
}

/** Options for the built-in state redactor. */
export interface RedactorOptions {
  /** Apply the built-in secret patterns. Default: true. */
  secrets?: boolean
  /** Extra patterns applied after the built-in rules, in order. */
  extraPatterns?: RedactionPattern[]
}

/** Caller-supplied policy overrides. All fields are optional. */
export interface GuardPolicyInput {
  /** Probability at or above which a hazard goes to `review`. Default: 0.35. */
  reviewThreshold?: number
  /** Probability at or above which `actions[name]` fires. Default: 0.70. */
  actionThreshold?: number
  /** Severity score at or above which the item is reviewed. Default: 1.25. */
  severityReview?: number
  /** Severity score at or above which a review is escalated to a block. Default: 2.0. */
  severityBlock?: number
  /**
   * Hazard name to action at the action threshold. `null` means "ignore this
   * hazard"; an omitted hazard uses {@link ResolvedGuardPolicy.fallback}.
   */
  actions?: Record<string, GuardAction | null>
  /** Action for a hazard the rules do not name at the action threshold. */
  fallback?: GuardAction
  /** Action precedence, highest first. Default: support > block > review > allow. */
  precedence?: readonly GuardAction[]
  /** Failure behavior when Jev cannot answer. Default: `open`. */
  failMode?: FailMode
}

/** A policy with every field resolved. */
export interface ResolvedGuardPolicy {
  reviewThreshold: number
  actionThreshold: number
  severityReview: number
  severityBlock: number
  actions: Record<string, GuardAction | null>
  fallback: GuardAction
  precedence: readonly GuardAction[]
  failMode: FailMode
}

/**
 * One named question set and the policy metadata that belongs with it.
 *
 * A battery is data: callers can copy a built-in one, edit the questions, and
 * pass their own labels and default action map.
 */
export interface Battery {
  /** Stable identifier, used in logs and cache provenance. */
  id: string
  /** Which side this battery screens. */
  side: GuardSide
  /** Human-readable purpose. */
  description: string
  /** Kind used in rendered reasons. */
  kind: GuardKind
  /** Typed Jev questions, keyed by hazard name. */
  questions: Questions
  /** Key of the severity `score` question, when the battery has one. */
  severityKey?: string
  /** Default action for each hazard at the action threshold. */
  defaultActions?: Record<string, GuardAction | null>
  /** Human-readable hazard labels used in reasons. */
  labels?: Record<string, string>
}

/** A description of one proposed agent action, screened before execution. */
export interface ActionDescriptor {
  /** Tool or function name, for example `Bash`, `edit`, or `run_code`. */
  tool: string
  /** Parsed arguments. Any JSON value is accepted. */
  arguments: unknown
  /** Session workspace root, when known. Used for scope checks and model context. */
  workspace?: string
  /** Current working directory, when different from the workspace root. */
  cwd?: string
  /** Optional one-line task description supplied by the model. */
  description?: string
  /** Whether untrusted content recently entered the model context. */
  untrustedContext?: boolean
}

/** Result of a purely local heuristic, when one applies. */
export interface LocalDecision {
  action: 'allow' | 'review' | 'block'
  /** Short explanation. */
  reason: string
  /** Stable rule id for logs and tests. */
  rule: string
}

/** One named hazard probability in a verdict. */
export interface HazardSummary {
  name: string
  /** Probability reported by Jev. */
  probability: number
  /** Human-readable label. */
  label: string
}

/** The library-level outcome of one screen. */
export interface GuardVerdict {
  side: GuardSide
  kind: GuardKind
  /** The action the caller should take. */
  action: GuardAction
  /** `jev` for a model call, `local` for a heuristic fast path. */
  source: 'jev' | 'local'
  /** Every hazard probability returned for this battery. */
  hazards: Record<string, number>
  /** Highest-probability hazard, when any hazard was returned. */
  topHazard?: HazardSummary
  /** Severity score, when the battery has a severity question. */
  severity?: number
  /** Confidence Jev reported for the severity score, when present. */
  severityConfidence?: number
  /** Every reason that contributed to the action, most important first. */
  reasons: string[]
  /** One-line human/model-readable summary. */
  reason: string
  /** Jev model that produced the answer. */
  model?: string
  /** Jev token usage and cost. */
  usage?: GuardUsage
  /** Whether the answer came from the in-memory cache. */
  cached: boolean
  /** True when the Jev call failed and `failMode` selected the action. */
  degraded: boolean
  /** Failure message for a degraded verdict. */
  error?: string
  /** Raw answers keyed by question id, for audit trails and tests. */
  rawAnswers?: Record<string, unknown>
}

/** Options accepted by every text screen. */
export interface ScreenOptions {
  /** Cancellation signal for the Jev request. */
  signal?: AbortSignal
  /** Per-call model override. */
  model?: string
  /** Per-call policy overrides, merged over the configured policy. */
  policy?: GuardPolicyInput
  /** Per-call question overrides. Use rarely; a policy keyed to another battery will not line up. */
  questions?: Questions
  /** Per-call severity question key override. */
  severityKey?: string
  /** Per-call hazard labels. */
  labels?: Record<string, string>
  /** Set to false to bypass the response cache for this call. */
  cache?: boolean
}

/** Options for `assessAction`. */
export interface AssessActionOptions extends ScreenOptions {
  /** Override the configured local-heuristics switch for this call. */
  heuristics?: boolean
}

/** Options for `verifyClaim`. */
export interface VerifyClaimOptions {
  /** The claim made by the model or a document. */
  claim: string
  /** The source text or excerpt the claim should be checked against. */
  evidence?: string
  /** Optional verbatim quote. A quote that does not appear in `evidence` is `fabricated` without a model call. */
  quote?: string
  /** Optional extra context sent to Jev (for example the question the claim answers). */
  context?: string
  /** Cancellation signal. */
  signal?: AbortSignal
  /** Per-call model override. */
  model?: string
  /** Confidence below which the result is marked `needsReview`. Default: 0.8. */
  autoAcceptConfidence?: number
  /** Set to false to bypass the response cache. */
  cache?: boolean
}

/** The outcome of a claim/citation verification. */
export interface ClaimVerdict {
  /** `fabricated` is local-only: the quoted text was not found in the evidence. */
  verdict: 'supported' | 'contradicted' | 'insufficient' | 'fabricated'
  /** True when confidence is below the acceptance threshold, or the verdict is `insufficient`. */
  needsReview: boolean
  /** Confidence reported by Jev, or 1 for a local quote mismatch. */
  confidence: number
  /** Full probability distribution for the relationship question. */
  probabilities: Record<string, number>
  /** Human/model-readable explanation. */
  reason: string
  /** Which method produced the verdict. */
  method: 'string-match' | 'jev'
  model?: string
  usage?: GuardUsage
  cached: boolean
  degraded: boolean
  error?: string
}

/** Options for constructing a `JevGuardrails` instance. */
export interface JevGuardrailsOptions {
  /**
   * Which service answers the questions. Default: `typesafe`.
   * `openrouter` selects OpenRouter's Decisions API and uses
   * `OPENROUTER_API_KEY` when no explicit key is given. `hosted` selects the
   * paid eval service and uses `EVAL_API_KEY`.
   */
  provider?: JevProvider
  /**
   * Provider API key. Fallbacks: `TYPESAFE_API_KEY` for `typesafe`,
   * `OPENROUTER_API_KEY` for `openrouter`, `EVAL_API_KEY` for `hosted`.
   */
  apiKey?: string
  /**
   * API root or full endpoint. Defaults: `https://api.typesafe.ai` for
   * `typesafe`, `https://openrouter.ai/api/alpha/decisions` for `openrouter`,
   * `https://eval.seanbehan.ca` for `hosted`.
   */
  baseURL?: string
  /**
   * Default model. Defaults: `jev-latest` for `typesafe` and `hosted`,
   * `~typesafe/jev-latest` for `openrouter`.
   */
  model?: string
  /**
   * Inject a transport instead of constructing the official SDK client.
   * Useful for tests, proxies, and non-TypeSafe-compatible gateways.
   */
  client?: JevTransport
  /** Custom fetch implementation (both providers). */
  fetch?: Fetch
  /** Optional OpenRouter session id, used for observability grouping. */
  sessionId?: string
  /** Extra request headers for the OpenRouter provider. */
  headers?: Record<string, string>
  /** Per-request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number
  /** Retry-policy overrides for the official SDK client. */
  retries?: Partial<RetryPolicy>
  /** Default policy overrides applied to every side. */
  policy?: GuardPolicyInput
  /** Per-side policy overrides, merged over `policy`. */
  policies?: Partial<Record<GuardSide, GuardPolicyInput>>
  /** Per-side battery overrides. */
  batteries?: Partial<Record<GuardSide, Battery>>
  /** Enable local heuristics for action screening. Default: true. */
  heuristics?: boolean
  /** Disable the response cache with `false`. */
  cache?: false | Partial<CacheSettings>
  /** Redact known secret shapes before sending state to Jev. Default: true. */
  redact?: boolean | RedactorOptions
  /** Maximum characters of state sent per request. Longer state is middle-truncated. Default: 20000. */
  maxStateChars?: number
  /** Called once per verdict, at any action. Useful for audit logging. */
  onVerdict?: (verdict: GuardVerdict) => void
  /** Called when a Jev call fails; the returned verdict still follows `failMode`. */
  onError?: (error: unknown, context: { side: GuardSide; kind: GuardKind }) => void
  /** Logger used for non-fatal warnings. Default: the SDK's console logger at `warn`. */
  logger?: Logger
  /** Clock override for cache TTL tests. Default: `Date.now`. */
  now?: () => number
}

/** Aggregate counters for one `JevGuardrails` instance. */
export interface GuardrailsStats {
  checks: number
  cached: number
  degraded: number
  local: number
  bySide: Record<GuardSide, number>
}

/** JSON-serializable state accepted by Jev. */
export type JevState = string | JsonValue[] | { [key: string]: JsonValue } | null
