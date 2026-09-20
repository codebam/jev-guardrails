/**
 * Plugin configuration defaults and normalization.
 *
 * The Cordis schema in `index.mjs` owns UI/docs metadata; this module owns the
 * runtime merge so `apply()` behaves the same when called directly from tests
 * or an embedding app.
 *
 * @module @codebam/dsh-jev-guardrails/config
 */
import z from '@deepseek-ai/schemastery'

const PROVIDERS = ['auto', 'typesafe', 'openrouter', 'hosted']
const INPUT_MODES = ['off', 'observe', 'warn', 'block']
const ACTION_MODES = ['off', 'observe', 'enforce']
const OBSERVATION_MODES = ['off', 'observe', 'suspicious', 'all']
const OUTPUT_MODES = ['off', 'observe', 'steer']
const REVIEW_ACTIONS = ['ask', 'deny', 'allow']
const BLOCK_ACTIONS = ['ask', 'deny']
const INPUT_BLOCK_STYLES = ['reject', 'notice']
const FAIL_MODES = ['open', 'review', 'closed']
const GUARD_ACTIONS = ['allow', 'review', 'block', 'support']
const LOG_MODES = ['off', 'decisions', 'verbose']

/** Cordis/schemastery schema for the plugin row. */
export const Config = z.object({
  provider: z.union(PROVIDERS).default('auto').description('`auto` detects the provider from the available key; or force `typesafe` / `openrouter` / `hosted`.'),
  apiKey: z.string().required(false).description('Provider API key; falls back to TYPESAFE_API_KEY or OPENROUTER_API_KEY.'),
  baseURL: z.string().required(false).description('Provider API root or full endpoint, for gateways and tests.'),
  model: z.string().required(false).description('Jev model alias or version. Defaults to `jev-latest` (TypeSafe) or `~typesafe/jev-latest` (OpenRouter).'),
  sessionId: z.string().required(false).description('Optional OpenRouter session id for observability grouping.'),
  input: z.union(INPUT_MODES).default('block').description('What to do when screening an incoming prompt.'),
  inputBlockStyle: z.union(INPUT_BLOCK_STYLES).default('reject').description('`reject` stops the turn; `notice` replaces the prompt with a plugin notice so the model can explain the block.'),
  actions: z.union(ACTION_MODES).default('enforce').description('Whether proposed tool calls are screened, observed, or skipped.'),
  onActionReview: z.union(REVIEW_ACTIONS).default('ask').description('Map a `review` action to an approval prompt, a denial, or an allow.'),
  onActionBlock: z.union(BLOCK_ACTIONS).default('deny').description('Map a `block`/`support` action to a denial or an approval prompt.'),
  observations: z.union(OBSERVATION_MODES).default('suspicious').description('Whether tool results are screened for prompt injection and other untrusted-content hazards.'),
  outputs: z.union(OUTPUT_MODES).default('off').description('Whether completed model responses are screened; `steer` asks the model for a corrected response.'),
  heuristics: z.boolean().default(true).description('Use local fast paths before spending a Jev call.'),
  reviewThreshold: z.number().min(0).max(1).default(0.35).description('Hazard probability that routes to review.'),
  actionThreshold: z.number().min(0).max(1).default(0.7).description('Hazard probability that triggers its configured action.'),
  severityReview: z.number().min(0).default(1.25).description('Severity score (0-3) that routes to review.'),
  severityBlock: z.number().min(0).default(2).description('Severity score (0-3) that escalates a review to a block.'),
  failMode: z.union(FAIL_MODES).default('open').description('What to do when the Jev call fails: allow, review, or block.'),
  unknownHazardAction: z.union(GUARD_ACTIONS).default('review').description('Action for a hazard the action rules do not name.'),
  actionRules: z.dict(z.union(GUARD_ACTIONS)).required(false).description('Per-hazard action overrides for tool calls, e.g. `{ remote_code: review }`.'),
  cacheTtlMs: z.number().min(0).default(60 * 60 * 1000).description('How long a cached Jev answer stays valid.'),
  cacheMaxEntries: z.number().min(1).default(500).description('Maximum cached Jev answers.'),
  maxStateChars: z.number().min(200).default(20000).description('Maximum characters of state sent to Jev per check.'),
  redact: z.boolean().default(true).description('Redact known secret shapes before sending state to Jev.'),
  timeoutMs: z.number().min(100).default(5000).description('Per-request timeout in milliseconds.'),
  skipTools: z.array(z.string()).required(false).description('Exact tool names that are never screened.'),
  guardTools: z.array(z.string()).required(false).description('When set, only these exact tool names are screened.'),
  log: z.union(LOG_MODES).default('decisions').description('Log non-allow verdicts, every verdict, or nothing.'),
})

const DEFAULTS = {
  provider: 'auto',
  input: 'block',
  inputBlockStyle: 'reject',
  actions: 'enforce',
  onActionReview: 'ask',
  onActionBlock: 'deny',
  observations: 'suspicious',
  outputs: 'off',
  heuristics: true,
  reviewThreshold: 0.35,
  actionThreshold: 0.7,
  severityReview: 1.25,
  severityBlock: 2,
  failMode: 'open',
  unknownHazardAction: 'review',
  actionRules: {},
  cacheTtlMs: 60 * 60 * 1000,
  cacheMaxEntries: 500,
  maxStateChars: 20000,
  redact: true,
  timeoutMs: 5000,
  skipTools: [],
  guardTools: undefined,
  log: 'decisions',
}

/**
 * Merge user configuration over defaults and validate the cross-field
 * constraints the schema cannot express.
 * @param {object|undefined} input
 * @returns {typeof DEFAULTS & { skipTools: string[], guardTools: string[]|undefined }}
 */
export function normalizeConfig(input) {
  const raw = input ?? {}
  const config = { ...DEFAULTS, ...raw }
  config.actionRules = { ...DEFAULTS.actionRules, ...(raw.actionRules ?? {}) }
  config.skipTools = [...(raw.skipTools ?? DEFAULTS.skipTools)]
  // Schemastery normalizes a missing optional string array to `[]`; an empty
  // allow-list means "guard every tool", not "guard no tools".
  config.guardTools = raw.guardTools === undefined || raw.guardTools.length === 0 ? undefined : [...raw.guardTools]

  for (const [name, allowed] of [
    ['provider', PROVIDERS],
    ['input', INPUT_MODES],
    ['inputBlockStyle', INPUT_BLOCK_STYLES],
    ['actions', ACTION_MODES],
    ['onActionReview', REVIEW_ACTIONS],
    ['onActionBlock', BLOCK_ACTIONS],
    ['observations', OBSERVATION_MODES],
    ['outputs', OUTPUT_MODES],
    ['failMode', FAIL_MODES],
    ['unknownHazardAction', GUARD_ACTIONS],
    ['log', LOG_MODES],
  ]) {
    if (!allowed.includes(config[name])) {
      throw new Error(`dsh-jev-guardrails: ${name} must be one of ${allowed.join(', ')}`)
    }
  }
  for (const [name, value] of Object.entries(config.actionRules)) {
    if (!GUARD_ACTIONS.includes(value)) {
      throw new Error(`dsh-jev-guardrails: actionRules.${name} must be one of ${GUARD_ACTIONS.join(', ')}`)
    }
  }
  if (!Number.isFinite(config.reviewThreshold) || !Number.isFinite(config.actionThreshold)) {
    throw new Error('dsh-jev-guardrails: thresholds must be finite numbers')
  }
  if (config.reviewThreshold > config.actionThreshold) {
    throw new Error('dsh-jev-guardrails: reviewThreshold must be less than or equal to actionThreshold')
  }
  if (config.severityReview > config.severityBlock) {
    throw new Error('dsh-jev-guardrails: severityReview must be less than or equal to severityBlock')
  }
  config.provider = resolveProvider(config.provider, raw.apiKey)
  config.model = (typeof raw.model === 'string' && raw.model.trim().length > 0
    ? raw.model.trim()
    : config.provider === 'openrouter'
      ? '~typesafe/jev-latest'
      : 'jev-latest')
  return config
}

/**
 * Resolve `auto` to a concrete provider from the explicit key or the host
 * environment. The dsh launcher exports OPENROUTER_API_KEY from the host's
 * secret store, so a user with only that key gets the OpenRouter Decisions
 * provider without extra configuration.
 */
function resolveProvider(requested, explicitKey) {
  if (requested === 'typesafe' || requested === 'openrouter' || requested === 'hosted') return requested
  if (typeof explicitKey === 'string' && explicitKey.length > 0) {
    if (explicitKey.startsWith('sk-or-')) return 'openrouter'
    if (explicitKey.startsWith('eval_')) return 'hosted'
    return 'typesafe'
  }
  if ((process.env.TYPESAFE_API_KEY ?? '').trim().length > 0) return 'typesafe'
  if ((process.env.OPENROUTER_API_KEY ?? '').trim().length > 0) return 'openrouter'
  if ((process.env.EVAL_API_KEY ?? '').trim().length > 0) return 'hosted'
  return 'typesafe'
}

/**
 * Build the library options used by this plugin. Kept separate so tests can
 * assert the exact policy translation without booting a Cordis context.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function libraryOptions(config) {
  const policy = {
    reviewThreshold: config.reviewThreshold,
    actionThreshold: config.actionThreshold,
    severityReview: config.severityReview,
    severityBlock: config.severityBlock,
    failMode: config.failMode,
    fallback: config.unknownHazardAction,
  }
  return {
    provider: config.provider,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
    model: config.model,
    heuristics: config.heuristics,
    timeoutMs: config.timeoutMs,
    maxStateChars: config.maxStateChars,
    redact: config.redact,
    cache: config.cacheTtlMs === 0 ? false : { ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries },
    policies: {
      input: policy,
      output: policy,
      observation: policy,
      action: { ...policy, actions: config.actionRules },
    },
  }
}
