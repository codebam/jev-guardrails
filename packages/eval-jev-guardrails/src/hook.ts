/**
 * Shared hook policy used by the OpenCode plugin and the generated Hermes
 * plugin: turn one service verdict into an allow/block decision.
 *
 * The harness adapters only translate their native input/output shapes; the
 * decision table and fail-mode handling live here so all three harnesses
 * behave identically.
 *
 * @module @codebam/eval-jev-guardrails/hook
 */
import type { EvalGuardrailsClient } from './client.js'
import type { EvalActionDescriptor, EvalAction, EvalFailMode, EvalReviewMode, EvalVerdict, HookOutcome } from './types.js'

/** Default fail behavior when the service is unreachable. */
export const DEFAULT_FAIL_MODE: EvalFailMode = 'open'

/** Default treatment of a `review` verdict. */
export const DEFAULT_REVIEW_MODE: EvalReviewMode = 'deny'

/** One tool call about to be executed. */
export interface GuardToolAction {
  tool: string
  args?: unknown
  workspace?: string
  callID?: string
  sessionID?: string
}

/** Policy options for {@link guardToolAction}. */
export interface GuardToolActionOptions {
  reviewMode?: EvalReviewMode
  failMode?: EvalFailMode
}

/** Normalize a user/env value into a fail mode. Invalid values use `fallback`. */
export function normalizeFailMode(value: string | undefined, fallback: EvalFailMode = DEFAULT_FAIL_MODE): EvalFailMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'open' || normalized === 'review' || normalized === 'closed') return normalized
  return fallback
}

/** Normalize a user/env value into a review mode. Invalid values use `fallback`. */
export function normalizeReviewMode(value: string | undefined, fallback: EvalReviewMode = DEFAULT_REVIEW_MODE): EvalReviewMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'deny' || normalized === 'allow') return normalized
  return fallback
}

/** True when a service response carries one of the four documented actions. */
export function isEvalVerdict(value: unknown): value is EvalVerdict {
  if (value === null || typeof value !== 'object') return false
  const action = (value as Record<string, unknown>).action
  return action === 'allow' || action === 'review' || action === 'block' || action === 'support'
}

/** Build the model-facing reason for a blocked call. */
export function verdictReason(verdict: EvalVerdict | undefined, tool: string): string {
  const reason = nonEmpty(verdict?.reason)
  if (reason !== undefined) return reason
  const reasons = verdict?.reasons
  if (Array.isArray(reasons)) {
    for (const entry of reasons) {
      const text = nonEmpty(entry)
      if (text !== undefined) return text
    }
  }
  const hazard = topHazard(verdict?.hazards)
  if (hazard !== undefined) {
    const probability = hazard.probability !== undefined ? ` (${Math.round(hazard.probability * 100)}% confidence)` : ''
    return `Blocked by eval guardrails: the tool call \`${tool}\` was flagged as ${hazard.name}${probability}. Do not retry it or route around this guardrail. Tell the user what was blocked and why.`
  }
  if (typeof verdict?.severity === 'number' && Number.isFinite(verdict.severity)) {
    return `Blocked by eval guardrails: the tool call \`${tool}\` scored severity ${verdict.severity.toFixed(1)}/3. Do not retry it or route around this guardrail. Tell the user what was blocked and why.`
  }
  return `Blocked by eval guardrails: the tool call \`${tool}\` was flagged as unsafe. Do not retry it or route around this guardrail. Tell the user what was blocked and why.`
}

/**
 * Evaluate one proposed tool call and apply `reviewMode` + `failMode`.
 *
 * A service `block` or `support` verdict always blocks. A `review` verdict
 * blocks unless `reviewMode` is `allow`. Transport/HTTP/malformed failures
 * follow `failMode`: `open` allows, `review` uses the review policy, and
 * `closed` blocks.
 */
export async function guardToolAction(
  client: EvalGuardrailsClient,
  action: GuardToolAction,
  options: GuardToolActionOptions = {},
): Promise<HookOutcome> {
  const reviewMode = options.reviewMode ?? DEFAULT_REVIEW_MODE
  const failMode = options.failMode ?? DEFAULT_FAIL_MODE
  const tool = action.tool.length > 0 ? action.tool : 'unknown'
  const args = action.args ?? {}
  const descriptor: EvalActionDescriptor = {
    tool,
    arguments: args,
    ...(action.workspace !== undefined ? { workspace: action.workspace } : {}),
    ...(action.sessionID !== undefined ? { sessionID: action.sessionID } : {}),
    ...(action.callID !== undefined ? { callID: action.callID } : {}),
  }
  const state = {
    tool,
    arguments: args,
    ...(action.workspace !== undefined ? { workspace: action.workspace } : {}),
  }

  let evaluation: unknown
  try {
    evaluation = await client.evaluate('action', state, descriptor)
  } catch (error) {
    return failOutcome(failMode, reviewMode, tool, errorMessage(error))
  }

  const verdict =
    evaluation !== null && typeof evaluation === 'object'
      ? (evaluation as Record<string, unknown>).verdict
      : undefined
  if (!isEvalVerdict(verdict)) {
    return failOutcome(failMode, reviewMode, tool, 'the service returned no valid verdict')
  }

  const serviceAction: EvalAction = verdict.action
  if (serviceAction === 'block' || serviceAction === 'support') {
    return { decision: 'block', verdict, reason: verdictReason(verdict, tool), degraded: false }
  }
  if (serviceAction === 'review') {
    const reason = `Flagged for review by eval guardrails: ${verdictReason(verdict, tool)}`
    if (reviewMode === 'deny') {
      return { decision: 'block', verdict, reason, degraded: false }
    }
    return { decision: 'allow', verdict, reason, degraded: false }
  }
  return { decision: 'allow', verdict, degraded: false }
}

function failOutcome(failMode: EvalFailMode, reviewMode: EvalReviewMode, tool: string, detail: string): HookOutcome {
  if (failMode === 'closed') {
    return {
      decision: 'block',
      reason: `Blocked by eval guardrails: the eval service could not decide this tool call (${detail}) and EVAL_FAIL_MODE=closed. Do not retry it or route around this guardrail.`,
      degraded: true,
      error: detail,
    }
  }
  if (failMode === 'review' && reviewMode === 'deny') {
    return {
      decision: 'block',
      reason: `Flagged for review by eval guardrails: the eval service could not decide this tool call (${detail}) and EVAL_FAIL_MODE=review. Do not retry it or route around this guardrail.`,
      degraded: true,
      error: detail,
    }
  }
  return { decision: 'allow', degraded: true, error: detail }
}

function topHazard(hazards: Record<string, number> | undefined): { name: string; probability?: number } | undefined {
  if (hazards === undefined || hazards === null || typeof hazards !== 'object') return undefined
  let bestName: string | undefined
  let bestValue: number | undefined
  for (const [name, value] of Object.entries(hazards)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (bestValue === undefined || value > bestValue) {
      bestName = name
      bestValue = value
    }
  }
  if (bestName === undefined) return undefined
  return { name: bestName.replace(/_/g, ' '), probability: bestValue }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
