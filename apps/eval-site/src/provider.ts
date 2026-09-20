/**
 * OpenRouter Decisions API client.
 *
 * The service owns the provider key: user requests never choose the upstream
 * URL or bearer token. Tests inject a fake `fetch`, so no test ever reaches
 * the real API.
 */
import {
  OPENROUTER_DECISIONS_ENDPOINT,
  OPENROUTER_DEFAULT_MODEL,
  normalizeOpenRouterModel,
  resolveOpenRouterEndpoint,
} from '@codebam/jev-guardrails'
import type { GuardUsage } from '@codebam/jev-guardrails'
import type { Env } from './types.js'

/** Failure raised when the upstream provider cannot produce usable answers. */
export class ProviderError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

/** One Decisions request. */
export interface DecisionsRequest {
  model?: string
  state: unknown
  questions: Record<string, { type: string }>
}

/** Normalized Decisions response. */
export interface DecisionsResult {
  model: string
  answers: Record<string, unknown>
  usage: GuardUsage
}

/** Call one Decisions request. */
export type DecisionsCaller = (input: DecisionsRequest, env: Env) => Promise<DecisionsResult>

const DEFAULT_TIMEOUT_MS = 15_000

/** Resolve the hosted model for a request, defaulting to `~typesafe/jev-latest`. */
export function resolveModel(env: Env, requested?: string): string {
  const raw = requested?.trim() || env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL
  return normalizeOpenRouterModel(raw)
}

/** Only Jev models may be requested through the service. */
export function isSupportedJevModel(model: string): boolean {
  return model === OPENROUTER_DEFAULT_MODEL || model.startsWith('typesafe/jev') || model.startsWith('~typesafe/jev')
}

/** True for plain JSON objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the production Decisions caller. The returned function resolves
 * configuration from `env` on every call so tests can vary it per request.
 */
export function createDecisionsCaller(fetchImpl: typeof globalThis.fetch): DecisionsCaller {
  return async (input, env) => {
    const apiKey = env.OPENROUTER_API_KEY?.trim()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ProviderError(0, 'OPENROUTER_API_KEY is not configured on the service')
    }
    const model = resolveModel(env, input.model)
    const endpoint = resolveOpenRouterEndpoint(env.OPENROUTER_BASE_URL)
    const timeoutMs = parseTimeout(env.OPENROUTER_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'HTTP-Referer': 'https://eval.seanbehan.ca',
          'X-Title': 'eval.seanbehan.ca',
        },
        body: JSON.stringify({ model, state: input.state, questions: input.questions }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ProviderError(0, `OpenRouter Decisions request timed out after ${timeoutMs}ms`)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new ProviderError(0, `OpenRouter Decisions request failed: ${message}`)
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new ProviderError(response.status, `OpenRouter Decisions request failed (${response.status})${detail.length > 0 ? `: ${detail}` : ''}`)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ProviderError(response.status, `OpenRouter Decisions returned invalid JSON: ${message}`)
    }
    if (!isRecord(payload)) {
      throw new ProviderError(response.status, 'OpenRouter Decisions returned a non-object response')
    }
    if (!isRecord(payload.answers)) {
      throw new ProviderError(response.status, 'OpenRouter Decisions response is missing the answers object')
    }
    return {
      model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
      answers: payload.answers,
      usage: parseUsage(payload.usage),
    }
  }
}

/** Validate that every battery question has an answer of the expected type. */
export function validateAnswers(
  questions: Record<string, { type: string }>,
  answers: Record<string, unknown>,
): void {
  if (!isRecord(answers)) throw new ProviderError(200, 'the provider response did not contain an answers object')
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name]
    if (!isRecord(answer)) {
      throw new ProviderError(200, `the provider response is missing the answer "${name}"`)
    }
    if (answer.type !== question.type) {
      throw new ProviderError(200, `the provider answer "${name}" has type "${String(answer.type)}", expected "${question.type}"`)
    }
    if (question.type === 'noul') {
      const probability = answer.noul
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new ProviderError(200, `the provider noul answer "${name}" is not a probability`)
      }
    } else if (question.type === 'score') {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
        throw new ProviderError(200, `the provider score answer "${name}" is not finite`)
      }
    } else if (question.type === 'choice') {
      if (typeof answer.choice !== 'string') {
        throw new ProviderError(200, `the provider choice answer "${name}" is not a label`)
      }
    } else {
      throw new ProviderError(200, `the provider answer "${name}" has an unsupported question type`)
    }
  }
}

/** Turn an unknown provider failure into a stable, non-secret message. */
export function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseTimeout(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(parsed), 120_000)
}

function parseUsage(raw: unknown): GuardUsage {
  const record = isRecord(raw) ? raw : {}
  const inputTokens = finiteNumber(record.input_tokens) ?? 0
  const outputTokens = finiteNumber(record.output_tokens) ?? 0
  const cost = finiteNumber(record.cost)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cost !== undefined ? { cost } : {}),
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string') return message.slice(0, 300)
  } catch {
    // Not JSON; use the raw text below.
  }
  return text.slice(0, 300)
}
