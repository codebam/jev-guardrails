/**
 * Probabilities to product actions.
 *
 * TypeSafe answers the questions; this module owns the decision. The same
 * answers under a different policy are a different product, so every policy
 * field is explicit and overridable.
 *
 * @module @codebam/jev-guardrails/policies
 */
import type {
  Battery,
  GuardAction,
  GuardPolicyInput,
  GuardSide,
  ResolvedGuardPolicy,
} from './types.js'
import { formatP } from './util.js'

/** Highest precedence first. `support` routes to a crisis path, not a refusal. */
export const DEFAULT_PRECEDENCE: readonly GuardAction[] = ['support', 'block', 'review', 'allow']

/** Default action map for the text-input battery. */
export const INPUT_ACTIONS: Record<string, GuardAction | null> = {
  jailbreak: 'block',
  harmful_request: 'block',
  medical_advice: 'review',
  self_harm: 'support',
}

/** Default action map for the model-output battery. */
export const OUTPUT_ACTIONS: Record<string, GuardAction | null> = {
  broke_policy: 'block',
  harmful_request: 'block',
  medical_advice: 'review',
  self_harm: 'support',
}

/** Default action map for untrusted text that entered the model context. */
export const OBSERVATION_ACTIONS: Record<string, GuardAction | null> = {
  injection: 'block',
  destructive: 'block',
  exfiltration: 'block',
  secrets: 'review',
  hidden: 'review',
  urgency: 'review',
}

/** Default action map for a proposed agent action. */
export const ACTION_ACTIONS: Record<string, GuardAction | null> = {
  destructive: 'block',
  exfiltration: 'block',
  remote_code: 'block',
  weakens_security: 'block',
  credential_access: 'review',
  outside_scope: 'review',
  consequential: 'review',
}

/** Default action map per side. */
export const DEFAULT_ACTIONS: Record<GuardSide, Record<string, GuardAction | null>> = {
  input: INPUT_ACTIONS,
  output: OUTPUT_ACTIONS,
  observation: OBSERVATION_ACTIONS,
  action: ACTION_ACTIONS,
}

/** Merge a caller policy over a battery's defaults. */
export function resolvePolicy(
  side: GuardSide,
  overrides: GuardPolicyInput | undefined,
  battery: Battery,
): ResolvedGuardPolicy {
  const baseActions = battery.defaultActions ?? DEFAULT_ACTIONS[side]
  const actions: Record<string, GuardAction | null> = { ...baseActions }
  if (overrides?.actions) {
    for (const [name, action] of Object.entries(overrides.actions)) actions[name] = action
  }
  const precedence = overrides?.precedence ?? DEFAULT_PRECEDENCE
  if (precedence.length === 0) throw new Error('jev-guardrails: policy precedence must not be empty')

  const reviewThreshold = requireProbability(overrides?.reviewThreshold ?? 0.35, 'reviewThreshold')
  const actionThreshold = requireProbability(overrides?.actionThreshold ?? 0.7, 'actionThreshold')
  if (reviewThreshold > actionThreshold) {
    throw new Error('jev-guardrails: reviewThreshold must be less than or equal to actionThreshold')
  }
  const severityReview = requireNonNegative(overrides?.severityReview ?? 1.25, 'severityReview')
  const severityBlock = requireNonNegative(overrides?.severityBlock ?? 2.0, 'severityBlock')
  if (severityReview > severityBlock) {
    throw new Error('jev-guardrails: severityReview must be less than or equal to severityBlock')
  }

  return {
    reviewThreshold,
    actionThreshold,
    severityReview,
    severityBlock,
    actions,
    fallback: overrides?.fallback ?? 'review',
    precedence,
    failMode: overrides?.failMode ?? 'open',
  }
}

function requireProbability(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`jev-guardrails: ${name} must be a probability between 0 and 1`)
  }
  return value
}

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`jev-guardrails: ${name} must be a non-negative number`)
  }
  return value
}

/** One triggered reason and its candidate action. */
export interface TriggeredHazard {
  name: string
  probability: number
  action: GuardAction
  reason: string
}

/** The complete route recommendation from one set of hazard probabilities. */
export interface RouteResult {
  action: GuardAction
  reasons: string[]
  triggered: TriggeredHazard[]
  /** True when a severity score upgraded at least one review to a block. */
  severityEscalated: boolean
}

/** The pure routing function: hazards + severity + policy -> one action. */
export function routePolicy(input: {
  hazards: Record<string, number>
  severity?: number
  policy: ResolvedGuardPolicy
}): RouteResult {
  const { hazards, severity, policy } = input
  const candidates: TriggeredHazard[] = []

  for (const [name, rawProbability] of Object.entries(hazards)) {
    const probability = Number.isFinite(rawProbability) ? rawProbability : 0
    const configured = policy.actions[name]
    if (configured === null) continue
    if (probability >= policy.actionThreshold) {
      const action = configured ?? policy.fallback
      candidates.push({
        name,
        probability,
        action,
        reason: `${name} ${formatP(probability)} at or above action threshold -> ${action}`,
      })
    } else if (probability >= policy.reviewThreshold) {
      candidates.push({
        name,
        probability,
        action: 'review',
        reason: `${name} ${formatP(probability)} at or above review threshold -> review`,
      })
    }
  }

  let severityEscalated = false
  if (severity !== undefined && Number.isFinite(severity)) {
    if (severity >= policy.severityBlock) {
      for (const candidate of candidates) {
        if (candidate.action === 'review') {
          candidate.action = 'block'
          candidate.reason = `${candidate.reason}; severity ${severity.toFixed(2)} escalated review to block`
          severityEscalated = true
        }
      }
      const alreadyBlocking = candidates.some((candidate) => candidate.action === 'block')
      if (!alreadyBlocking) {
        candidates.push({
          name: 'severity',
          probability: 1,
          action: 'block',
          reason: `severity ${severity.toFixed(2)} at or above block threshold -> block`,
        })
      }
    } else if (severity >= policy.severityReview) {
      candidates.push({
        name: 'severity',
        probability: 1,
        action: 'review',
        reason: `severity ${severity.toFixed(2)} at or above review threshold -> review`,
      })
    }
  }

  const action = policy.precedence.find((candidateAction) =>
    candidates.some((candidate) => candidate.action === candidateAction),
  ) ?? 'allow'

  const reasons = candidates
    .filter((candidate) => candidate.action === action || action === 'allow')
    .map((candidate) => candidate.reason)
    .sort((a, b) => actionRank(b, policy) - actionRank(a, policy))

  return { action, reasons, triggered: candidates, severityEscalated }
}

function actionRank(reason: string, policy: ResolvedGuardPolicy): number {
  const index = policy.precedence.findIndex((action) => reason.includes(`-> ${action}`))
  return index === -1 ? 0 : policy.precedence.length - index
}

/** A concise, model-readable summary of the top hazards in a decision. */
export function summarizeHazards(
  hazards: Record<string, number>,
  labels: Record<string, string> = {},
): string {
  const entries = Object.entries(hazards)
    .filter(([, probability]) => Number.isFinite(probability))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  if (entries.length === 0) return 'no hazard above threshold'
  return entries
    .map(([name, probability]) => `${labels[name] ?? name} ${formatP(probability)}`)
    .join('; ')
}
