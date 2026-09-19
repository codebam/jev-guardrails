/**
 * `JevGuardrails`: the public entry point that ties batteries, policies, the
 * Jev call layer, local heuristics, and claim verification together.
 *
 * @module @codebam/jev-guardrails/guardrails
 */
import { choice } from '@typesafe-ai/sdk'
import type { Questions, SystemOneRequest } from '@typesafe-ai/sdk'
import { ACTION_BATTERY, DEFAULT_BATTERIES, INPUT_BATTERY, OBSERVATION_BATTERY, OUTPUT_BATTERY } from './batteries.js'
import { GuardrailsError, JevCaller, createTransport } from './client.js'
import type { AskOptions, AskResult } from './client.js'
import { classifyActionLocally } from './heuristics.js'
import { DEFAULT_PRECEDENCE, resolvePolicy, routePolicy } from './policies.js'
import { DEFAULT_HAZARD_LABELS, describeVerdict } from './render.js'
import type {
  ActionDescriptor,
  AssessActionOptions,
  Battery,
  ClaimVerdict,
  GuardAction,
  GuardKind,
  GuardPolicyInput,
  GuardSide,
  GuardVerdict,
  GuardrailsStats,
  JevGuardrailsOptions,
  ResolvedGuardPolicy,
  ScreenOptions,
  VerifyClaimOptions,
} from './types.js'
import { contentToText, formatProbability, topEntries } from './util.js'

const ALL_SIDES: readonly GuardSide[] = ['input', 'output', 'observation', 'action']

/**
 * Jev-backed guardrails with one local cache, one policy set, and one
 * transport.
 *
 * The class is safe to share across requests; each call is independent and
 * cancellation is per call.
 */
export class JevGuardrails {
  private readonly caller: JevCaller
  private readonly model: string
  private readonly heuristics: boolean
  private readonly batteries: Record<GuardSide, Battery>
  private readonly policyOverrides: Partial<Record<GuardSide, GuardPolicyInput>>
  private readonly onVerdict: ((verdict: GuardVerdict) => void) | undefined
  private readonly onError: ((error: unknown, context: { side: GuardSide; kind: GuardKind }) => void) | undefined
  private readonly counters = {
    checks: 0,
    cached: 0,
    degraded: 0,
    local: 0,
    bySide: { input: 0, output: 0, observation: 0, action: 0 } as Record<GuardSide, number>,
  }

  constructor(options: JevGuardrailsOptions = {}) {
    this.model =
      options.model?.trim() ||
      (options.provider === 'openrouter' ? '~typesafe/jev-latest' : 'jev-latest')
    this.heuristics = options.heuristics ?? true
    this.batteries = {
      input: options.batteries?.input ?? INPUT_BATTERY,
      output: options.batteries?.output ?? OUTPUT_BATTERY,
      observation: options.batteries?.observation ?? OBSERVATION_BATTERY,
      action: options.batteries?.action ?? ACTION_BATTERY,
    }
    for (const side of ALL_SIDES) {
      resolvePolicy(side, options.policies?.[side] ?? options.policy, this.batteries[side])
    }
    this.policyOverrides = {
      ...(options.policy !== undefined ? { input: options.policy, output: options.policy, observation: options.policy, action: options.policy } : {}),
      ...options.policies,
    }
    this.onVerdict = options.onVerdict
    this.onError = options.onError

    this.caller = new JevCaller({
      transport: createTransport({
        model: this.model,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        ...(options.client !== undefined ? { client: options.client } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        timeoutMs: options.timeoutMs ?? 5000,
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      }),
      model: this.model,
      cache: options.cache === false ? false : options.cache ?? {},
      redact: normalizeRedaction(options.redact),
      maxStateChars: options.maxStateChars ?? 20000,
      timeoutMs: options.timeoutMs ?? 5000,
      ...(options.retries !== undefined ? { retries: options.retries } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  }

  /** Low-level ask against the same transport, cache, and redactor. */
  async ask<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: AskOptions = {},
  ): Promise<AskResult<Q>> {
    return this.caller.ask(request, options)
  }

  /** Screen a user prompt before it reaches the model. */
  async screenInput(text: string, options: ScreenOptions = {}): Promise<GuardVerdict> {
    return this.screenText('input', text, options)
  }

  /** Screen a model response before the user sees it. */
  async screenOutput(text: string, options: ScreenOptions = {}): Promise<GuardVerdict> {
    return this.screenText('output', text, options)
  }

  /** Screen untrusted text a model is about to read. */
  async screenObservation(text: string, options: ScreenOptions = {}): Promise<GuardVerdict> {
    return this.screenText('observation', text, options)
  }

  /**
   * Score one proposed tool call before execution.
   *
   * Local rules resolve routine and obviously dangerous calls without a model
   * call; everything ambiguous goes to Jev.
   */
  async assessAction(
    action: ActionDescriptor | string,
    options: AssessActionOptions = {},
  ): Promise<GuardVerdict> {
    const descriptor: ActionDescriptor = typeof action === 'string' ? { tool: 'command', arguments: action } : action
    this.counters.checks += 1
    this.counters.bySide.action += 1
    this.counters.cached += 0
    const policy = this.policyFor('action', options)

    if ((options.heuristics ?? this.heuristics) === true) {
      const local = classifyActionLocally(descriptor)
      if (local !== undefined) {
        const verdict = this.localVerdict('action', local.action, local.reason, policy)
        this.onVerdict?.(verdict)
        return verdict
      }
    }

    const state = buildActionState(descriptor)
    return this.screenState('action', state, options, policy)
  }

  /**
   * Verify one claim against its evidence.
   *
   * A supplied quote that is not present in the evidence is `fabricated`
   * without spending a model call; everything else goes to one Choice question.
   */
  async verifyClaim(options: VerifyClaimOptions): Promise<ClaimVerdict> {
    const claim = options.claim?.trim()
    if (claim === undefined || claim.length === 0) throw new Error('jev-guardrails: verifyClaim requires a non-empty claim')
    const evidence = options.evidence
    const quote = options.quote

    if (quote !== undefined && quote.trim().length > 0 && evidence !== undefined) {
      if (!normalizeForQuoteMatch(evidence).includes(normalizeForQuoteMatch(quote))) {
        return {
          verdict: 'fabricated',
          needsReview: true,
          confidence: 1,
          probabilities: { fabricated: 1 },
          reason: 'The quoted text does not appear in the supplied evidence.',
          method: 'string-match',
          cached: false,
          degraded: false,
        }
      }
    }

    const questions = {
      relationship: choice('Given the evidence, what is the relationship between the evidence and the claim?', {
        supported: 'The evidence clearly supports the claim.',
        contradicted: 'The evidence clearly contradicts the claim.',
        insufficient: 'The evidence does not contain enough information to judge the claim.',
      }),
    } as const

    const autoAccept = options.autoAcceptConfidence ?? 0.8
    try {
      const { result, cached } = await this.caller.ask(
        {
          state: {
            claim,
            quote: quote ?? null,
            evidence: evidence ?? null,
            context: options.context ?? null,
          },
          questions,
          model: options.model ?? this.model,
        },
        { signal: options.signal, cache: options.cache },
      )
      const answer = result.answers.relationship
      if (answer.type !== 'choice') throw new GuardrailsError('MALFORMED', 'the verification answer was not a choice')
      const rawChoice = String(answer.choice)
      const verdict: ClaimVerdict['verdict'] = rawChoice === 'supported' || rawChoice === 'contradicted' || rawChoice === 'insufficient'
        ? rawChoice
        : 'insufficient'
      const confidence = answer.confidence
      const needsReview = verdict === 'insufficient' || confidence < autoAccept
      const probabilities = { ...answer.probabilities }
      return {
        verdict,
        needsReview,
        confidence,
        probabilities,
        reason: describeClaimVerdict(verdict, confidence, needsReview),
        method: 'jev',
        model: result.model,
        usage: result.usage,
        cached,
        degraded: false,
      }
    } catch (error) {
      this.counters.degraded += 1
      this.onError?.(error, { side: 'output', kind: 'response' })
      const message = error instanceof Error ? error.message : String(error)
      throw error instanceof GuardrailsError
        ? error
        : new GuardrailsError('TRANSPORT', `claim verification failed: ${message}`, error)
    }
  }

  /** Drop every cached answer. */
  clearCache(): void {
    this.caller.clearCache()
  }

  /** Aggregate counters since construction. */
  get stats(): GuardrailsStats {
    return {
      checks: this.counters.checks,
      cached: this.counters.cached,
      degraded: this.counters.degraded,
      local: this.counters.local,
      bySide: { ...this.counters.bySide },
    }
  }

  private policyFor(side: GuardSide, options: ScreenOptions): ResolvedGuardPolicy {
    const battery = this.batteries[side]
    const override = mergePolicies(this.policyOverrides[side], options.policy)
    return resolvePolicy(side, override, battery)
  }

  private async screenText(side: Exclude<GuardSide, 'action'>, text: string, options: ScreenOptions): Promise<GuardVerdict> {
    const policy = this.policyFor(side, options)
    const state = typeof text === 'string' ? text : contentToText(text)
    return this.screenState(side, state, options, policy)
  }

  private async screenState(
    side: GuardSide,
    state: unknown,
    options: ScreenOptions,
    policy: ResolvedGuardPolicy,
  ): Promise<GuardVerdict> {
    this.counters.checks += 1
    this.counters.bySide[side] += 1
    const battery = this.batteries[side]
    const kind = battery.kind

    if (typeof state === 'string' && state.trim().length === 0) {
      this.counters.local += 1
      const verdict = this.localVerdict(side, 'allow', 'empty input has no hazard surface', policy)
      this.onVerdict?.(verdict)
      return verdict
    }

    const questions = options.questions ?? battery.questions
    const severityKey = options.severityKey ?? battery.severityKey
    try {
      const { result, cached } = await this.caller.ask(
        { state: state as never, questions, model: options.model ?? this.model },
        { signal: options.signal, cache: options.cache },
      )
      if (cached) this.counters.cached += 1
      const verdict = this.buildVerdict({
        side,
        kind,
        battery,
        labels: options.labels,
        policy,
        questions,
        severityKey,
        result: result as never,
        cached,
      })
      this.onVerdict?.(verdict)
      return verdict
    } catch (error) {
      this.counters.degraded += 1
      this.onError?.(error, { side, kind })
      const verdict = this.failureVerdict(side, kind, policy, error)
      this.onVerdict?.(verdict)
      return verdict
    }
  }

  private buildVerdict(input: {
    side: GuardSide
    kind: GuardKind
    battery: Battery
    labels: Record<string, string> | undefined
    policy: ResolvedGuardPolicy
    questions: Questions
    severityKey: string | undefined
    result: {
      model: string
      answers: Record<string, unknown>
      usage?: { input_tokens: number; output_tokens: number }
    }
    cached: boolean
  }): GuardVerdict {
    const hazards: Record<string, number> = {}
    for (const [name, question] of Object.entries(input.questions)) {
      if (name === input.severityKey) continue
      const answer = input.result.answers[name]
      if (isNoulAnswer(answer)) hazards[name] = answer.noul
    }
    const severityAnswer = input.severityKey === undefined ? undefined : input.result.answers[input.severityKey]
    const severity = isScoreAnswer(severityAnswer) ? severityAnswer.score : undefined
    const severityConfidence = isScoreAnswer(severityAnswer) ? severityAnswer.confidence : undefined

    const route = routePolicy({ hazards, ...(severity !== undefined ? { severity } : {}), policy: input.policy })
    const labels = { ...(input.battery.labels ?? {}), ...(input.labels ?? {}) }
    const top = topEntries(hazards).find(([, probability]) => probability >= input.policy.reviewThreshold)
    const topHazard = top === undefined
      ? undefined
      : { name: top[0], probability: top[1], label: labels[top[0]] ?? DEFAULT_HAZARD_LABELS[top[0]] ?? top[0] }

    const draft: Omit<GuardVerdict, 'reason'> = {
      side: input.side,
      kind: input.kind,
      action: route.action,
      source: 'jev',
      hazards,
      ...(topHazard !== undefined ? { topHazard } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(severityConfidence !== undefined ? { severityConfidence } : {}),
      reasons: route.reasons,
      model: input.result.model,
      ...(input.result.usage !== undefined ? { usage: input.result.usage } : {}),
      cached: input.cached,
      degraded: false,
      rawAnswers: { ...input.result.answers },
    }
    return { ...draft, reason: describeVerdict(draft, labels) }
  }

  private localVerdict(
    side: GuardSide,
    action: GuardAction,
    reason: string,
    policy: ResolvedGuardPolicy,
  ): GuardVerdict {
    const draft: Omit<GuardVerdict, 'reason'> = {
      side,
      kind: side === 'action' ? 'action' : this.batteries[side].kind,
      action,
      source: 'local',
      hazards: {},
      reasons: [reason],
      cached: false,
      degraded: false,
    }
    if (action === 'allow') this.counters.local += 1
    void policy
    return { ...draft, reason: describeVerdict(draft) }
  }

  private failureVerdict(
    side: GuardSide,
    kind: GuardKind,
    policy: ResolvedGuardPolicy,
    error: unknown,
  ): GuardVerdict {
    const message = error instanceof Error ? error.message : String(error)
    const action: GuardAction = policy.failMode === 'open' ? 'allow' : policy.failMode === 'review' ? 'review' : 'block'
    const draft: Omit<GuardVerdict, 'reason'> = {
      side,
      kind,
      action,
      source: 'jev',
      hazards: {},
      reasons: [`Jev request failed: ${message}`],
      cached: false,
      degraded: true,
      error: message,
    }
    return { ...draft, reason: describeVerdict(draft) }
  }
}

/** Create a guardrails instance with the built-in batteries and policies. */
export function createGuardrails(options: JevGuardrailsOptions = {}): JevGuardrails {
  return new JevGuardrails(options)
}

function normalizeRedaction(value: JevGuardrailsOptions['redact']): false | import('./types.js').RedactorOptions {
  if (value === false) return false
  if (value === undefined || value === true) return {}
  return value
}

function mergePolicies(
  base: GuardPolicyInput | undefined,
  override: GuardPolicyInput | undefined,
): GuardPolicyInput | undefined {
  if (base === undefined) return override
  if (override === undefined) return base
  return {
    ...base,
    ...override,
    ...(base.actions !== undefined || override.actions !== undefined
      ? { actions: { ...(base.actions ?? {}), ...(override.actions ?? {}) } }
      : {}),
  }
}

function buildActionState(action: ActionDescriptor): Record<string, unknown> {
  return {
    kind: 'proposed_agent_action',
    tool: action.tool,
    arguments: action.arguments as never,
    ...(action.workspace !== undefined ? { workspace: action.workspace } : {}),
    ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
    ...(action.description !== undefined ? { description: action.description } : {}),
    ...(action.untrustedContext === true ? { untrusted_context_recently: true } : {}),
  }
}

function isNoulAnswer(value: unknown): value is { type: 'noul'; noul: number } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'noul' && typeof (value as { noul?: unknown }).noul === 'number'
}

function isScoreAnswer(value: unknown): value is { type: 'score'; score: number; confidence: number } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'score' && typeof (value as { score?: unknown }).score === 'number'
}

function normalizeForQuoteMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function describeClaimVerdict(
  verdict: ClaimVerdict['verdict'],
  confidence: number,
  needsReview: boolean,
): string {
  const confidenceText = `confidence ${formatProbability(confidence)}`
  if (verdict === 'supported') {
    return needsReview
      ? `The evidence appears to support the claim, but ${confidenceText} is below the acceptance threshold; review is recommended.`
      : `The evidence supports the claim (${confidenceText}).`
  }
  if (verdict === 'contradicted') {
    return needsReview
      ? `The evidence appears to contradict the claim, but ${confidenceText} is below the acceptance threshold; review is recommended.`
      : `The evidence contradicts the claim (${confidenceText}).`
  }
  return `The evidence is insufficient to judge the claim (${confidenceText}).`
}

export { DEFAULT_PRECEDENCE }
