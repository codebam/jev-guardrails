/**
 * Hosted eval-service transport.
 *
 * Points the library at `eval.seanbehan.ca` (or any compatible deployment)
 * through the SystemOne-shaped `/v1/systemone` endpoint. The service owns the
 * provider key, API keys, and credits; the library still owns the questions,
 * policies, redaction, and cache.
 *
 * @module @codebam/jev-guardrails/hosted
 */
import type { Fetch, Questions, RequestOptions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk'

/** Default hosted base URL. */
export const HOSTED_DEFAULT_BASE_URL = 'https://eval.seanbehan.ca'

/** Error raised for a non-2xx hosted-service response. */
export class HostedError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, message: string, body = '') {
    super(message)
    this.name = 'HostedError'
    this.status = status
    this.body = body
  }
}

/** Options for {@link HostedTransport}. */
export interface HostedTransportOptions {
  /** `eval_...` API key issued by the service. Required. */
  apiKey: string
  /** Base URL or full `/v1/systemone` endpoint. */
  baseURL?: string
  /** Default model id sent to the service. Default: `jev-latest`. */
  model?: string
  /** Fetch implementation. Default: global fetch. */
  fetch?: Fetch
  /** Maximum retries for 408/429/5xx responses. Default: 2. */
  maxRetries?: number
  /** First backoff in milliseconds. Default: 400. */
  backoffInitialMs?: number
}

/** SystemOne-compatible transport for the hosted eval service. */
export class HostedTransport {
  private readonly endpoint: string
  private readonly model: string
  private readonly apiKey: string
  private readonly fetchImpl: Fetch
  private readonly maxRetries: number
  private readonly backoffInitialMs: number

  constructor(options: HostedTransportOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new HostedError(401, 'the hosted eval service requires an API key')
    }
    this.endpoint = resolveHostedEndpoint(options.baseURL)
    this.model = options.model?.trim() ?? 'jev-latest'
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.backoffInitialMs = Math.max(1, options.backoffInitialMs ?? 400)
  }

  /** POST one SystemOne request to the hosted service. */
  async systemOne<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: RequestOptions = {},
  ): Promise<SystemOneResult<Q>> {
    const body = JSON.stringify({
      model: request.model ?? this.model,
      state: request.state,
      questions: request.questions,
    })
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            ...(options.headers ?? {}),
          },
          body,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        if (attempt < this.maxRetries) {
          await delay(this.backoffInitialMs * 2 ** attempt)
          attempt += 1
          continue
        }
        throw error
      }

      if (response.ok) return (await response.json()) as SystemOneResult<Q>
      const text = await response.text().catch(() => '')
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        await delay(this.backoffInitialMs * 2 ** attempt)
        attempt += 1
        continue
      }
      throw new HostedError(response.status, describeError(response.status, text), text)
    }
  }
}

/** Resolve a base URL or endpoint to the exact `/v1/systemone` URL. */
export function resolveHostedEndpoint(baseURL?: string): string {
  const trimmed = baseURL?.trim().replace(/\/+$/, '') ?? ''
  if (trimmed.length === 0) return `${HOSTED_DEFAULT_BASE_URL}/v1/systemone`
  if (trimmed.endsWith('/v1/systemone')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/systemone`
  return `${trimmed}/v1/systemone`
}

/** Build a hosted transport. */
export function createHostedTransport(options: HostedTransportOptions): HostedTransport {
  return new HostedTransport(options)
}

function describeError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string') return `hosted eval request failed (${status}): ${message}`
  } catch {
    // not JSON; use raw text
  }
  return `hosted eval request failed (${status})${text.length > 0 ? `: ${text.slice(0, 300)}` : ''}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
