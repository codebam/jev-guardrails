/**
 * Battery selection, request shaping, and verdict construction.
 *
 * The question wording and the hazard-to-action mapping come from
 * `@codebam/jev-guardrails`; this module only decides which built-in battery
 * applies to a request and wraps the library's routing result in the hosted
 * API response shape.
 */
import {
  DEFAULT_BATTERIES,
  describeVerdict,
  resolvePolicy,
  routePolicy,
  stableStringify,
  topEntries,
} from '@codebam/jev-guardrails'
import type {
  Battery,
  GuardAction,
  GuardSide,
  GuardUsage,
  GuardVerdict,
} from '@codebam/jev-guardrails'
import { sha256Hex } from './crypto.js'
import type { ApiVerdict } from './types.js'

/** Contract cap for the serialized state sent to Jev. */
export const MAX_STATE_CHARS = 12_000

const GUARD_SIDES: readonly GuardSide[] = ['input', 'output', 'observation', 'action']

/** True for one of the four contract sides. */
export function isGuardSide(value: unknown): value is GuardSide {
  return typeof value === 'string' && (GUARD_SIDES as readonly string[]).includes(value)
}

/** The built-in battery for a side. */
export function batteryForSide(side: GuardSide): Battery {
  return DEFAULT_BATTERIES[side]
}

/** Serialized-state length used to enforce the 12,000 character cap. */
export function measureState(state: unknown): number {
  if (state === null || state === undefined) return 0
  if (typeof state === 'string') return state.length
  return stableStringify(state).length
}

/**
 * Shape one incoming action descriptor the way the library's action battery
 * expects to receive it.
 */
export function buildActionState(action: Record<string, unknown>): Record<string, unknown> {
  const tool = action.tool
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    throw new Error('action.tool must be a non-empty string')
  }
  const workspace = optionalString(action.workspace)
  const cwd = optionalString(action.cwd)
  const description = optionalString(action.description)
  return {
    kind: 'proposed_agent_action',
    tool,
    arguments: action.arguments ?? null,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(action.untrustedContext === true ? { untrusted_context_recently: true } : {}),
  }
}

/** Canonical cache/evaluation key for one battery request. */
export async function requestHash(
  model: string,
  state: unknown,
  questions: Record<string, { type: string }>,
): Promise<string> {
  return sha256Hex(stableStringify({ model, state, questions }))
}

/** Canonical hash of a question set, used to restrict `/v1/systemone`. */
export async function questionsHash(questions: Record<string, unknown>): Promise<string> {
  return sha256Hex(stableStringify(questions))
}

/** Build the public verdict for a successful provider response. */
export function buildGuardVerdict(input: {
  side: GuardSide
  battery: Battery
  answers: Record<string, unknown>
  model: string
  usage?: GuardUsage
  cached: boolean
}): ApiVerdict {
  const { battery, side } = input
  const policy = resolvePolicy(side, undefined, battery)
  const hazards: Record<string, number> = {}
  for (const [name, question] of Object.entries(battery.questions)) {
    if (name === battery.severityKey) continue
    const answer = input.answers[name]
    if (question.type === 'noul' && isNoulAnswer(answer)) hazards[name] = answer.noul
  }

  const severityKey = battery.severityKey
  const severityAnswer = severityKey === undefined ? undefined : input.answers[severityKey]
  const severity = isScoreAnswer(severityAnswer) ? severityAnswer.score : undefined
  const severityConfidence = isScoreAnswer(severityAnswer) ? severityAnswer.confidence : undefined

  const route = routePolicy({
    hazards,
    ...(severity !== undefined ? { severity } : {}),
    policy,
  })
  const labels = battery.labels ?? {}
  const top = topEntries(hazards).find(([, probability]) => probability >= policy.reviewThreshold)
  const topHazard =
    top === undefined
      ? undefined
      : { name: top[0], probability: top[1], label: labels[top[0]] ?? top[0] }

  const draft: Omit<ApiVerdict, 'reason'> = {
    side,
    kind: battery.kind,
    action: route.action,
    source: 'jev',
    hazards,
    ...(topHazard !== undefined ? { topHazard } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(severityConfidence !== undefined ? { severityConfidence } : {}),
    reasons: route.reasons,
    model: input.model,
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    cached: input.cached,
    degraded: false,
    failMode: policy.failMode,
  }
  return { ...draft, reason: describeVerdict(draft, labels) }
}

/** Build a fail-open-style verdict when the provider cannot answer. */
export function degradedVerdict(side: GuardSide, battery: Battery, error: unknown): ApiVerdict {
  const message = error instanceof Error ? error.message : String(error)
  const policy = resolvePolicy(side, undefined, battery)
  const action: GuardAction =
    policy.failMode === 'open' ? 'allow' : policy.failMode === 'review' ? 'review' : 'block'
  const draft: Omit<ApiVerdict, 'reason'> = {
    side,
    kind: battery.kind,
    action,
    source: 'jev',
    hazards: {},
    reasons: [`Jev request failed: ${message}`],
    cached: false,
    degraded: true,
    error: message,
    failMode: policy.failMode,
  }
  return { ...draft, reason: describeVerdict(draft, battery.labels) }
}

function isNoulAnswer(value: unknown): value is { type: 'noul'; noul: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'noul' &&
    typeof (value as { noul?: unknown }).noul === 'number'
  )
}

function isScoreAnswer(value: unknown): value is { type: 'score'; score: number; confidence?: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'score' &&
    typeof (value as { score?: unknown }).score === 'number'
  )
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Re-export for callers building the same canonical hashes. */
export type { GuardVerdict }

/** Every built-in battery, used to restrict `/v1/systemone` question sets. */
export function allBatteries(): Battery[] {
  return Object.values(DEFAULT_BATTERIES)
}
