/**
 * The Jev call layer: official SDK client, state preparation, cache, timeout,
 * abort handling, and response validation.
 *
 * @module @codebam/jev-guardrails/client
 */
import { TypeSafeClient, TypeSafeError } from '@typesafe-ai/sdk'
import type {
  Fetch,
  Questions,
  RequestOptions,
  RetryPolicy,
  SystemOneRequest,
  SystemOneResult,
} from '@typesafe-ai/sdk'
import { createHash } from 'node:crypto'
import { ResponseCache } from './cache.js'
import { OpenRouterDecisionsTransport } from './openrouter.js'
import { redactState, redactString } from './redact.js'
import type { CacheSettings, JevProvider, JevTransport, RedactorOptions } from './types.js'
import { isRecord, stableStringify, truncateMiddle } from './util.js'

/** Error raised by configuration, transport, or response-validation failures. */
export class GuardrailsError extends Error {
  readonly code: 'CONFIG' | 'TRANSPORT' | 'MALFORMED' | 'ABORTED'

  constructor(code: GuardrailsError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GuardrailsError'
    this.code = code
  }
}

/** Options for the transport factory. */
export interface TransportOptions {
  provider?: JevProvider
  apiKey?: string
  baseURL?: string
  model: string
  client?: JevTransport
  fetch?: Fetch
  timeoutMs: number
  retries?: Partial<RetryPolicy>
  sessionId?: string
  headers?: Record<string, string>
}

/** Build the default Jev transport, or return an injected one unchanged. */
export function createTransport(options: TransportOptions): JevTransport {
  if (options.client !== undefined) return options.client
  if (options.provider === 'openrouter') {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    if (apiKey.trim().length === 0) {
      throw new GuardrailsError(
        'CONFIG',
        'an OpenRouter API key is required for provider "openrouter". Set OPENROUTER_API_KEY or pass apiKey explicitly.',
      )
    }
    return new OpenRouterDecisionsTransport({
      apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      model: options.model,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.retries !== undefined ? { retry: options.retries } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    })
  }
  try {
    return new TypeSafeClient({
      ...(options.apiKey !== undefined && options.apiKey.trim().length > 0 ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL !== undefined && options.baseURL.trim().length > 0 ? { baseURL: options.baseURL } : {}),
      defaultModel: options.model,
      timeout: options.timeoutMs,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.retries !== undefined ? { retry: options.retries } : {}),
      dangerouslyAllowBrowser: false,
    })
  } catch (error) {
    const message = error instanceof TypeSafeError ? error.message : `could not create the TypeSafe client: ${String(error)}`
    throw new GuardrailsError('CONFIG', `${message} Set TYPESAFE_API_KEY or pass apiKey/client explicitly.`, error)
  }
}

/** Options for one `JevCaller`. */
export interface CallerOptions {
  transport: JevTransport
  model: string
  cache: false | Partial<CacheSettings>
  redact: false | RedactorOptions
  maxStateChars: number
  timeoutMs: number
  retries?: Partial<RetryPolicy>
  now?: () => number
}

/** Per-call options. */
export interface AskOptions {
  signal?: AbortSignal
  /** Set to false to bypass the response cache. */
  cache?: boolean
}

/** One prepared result plus cache provenance. */
export interface AskResult<Q extends Questions> {
  result: SystemOneResult<Q>
  cached: boolean
}

/** Owns exactly one transport and its local policy around calls. */
export class JevCaller {
  private readonly transport: JevTransport
  private readonly model: string
  private readonly cache: ResponseCache | undefined
  private readonly redactor: false | RedactorOptions
  private readonly maxStateChars: number
  private readonly timeoutMs: number
  private readonly retries: Partial<RetryPolicy> | undefined

  constructor(options: CallerOptions) {
    this.transport = options.transport
    this.model = options.model
    this.cache = options.cache === false ? undefined : new ResponseCache(options.cache, options.now)
    this.redactor = options.redact
    this.maxStateChars = Math.max(64, options.maxStateChars)
    this.timeoutMs = Math.max(100, options.timeoutMs)
    this.retries = options.retries
  }

  /** Remove every cached answer. */
  clearCache(): void {
    this.cache?.clear()
  }

  /** Number of live cache entries. */
  get cacheSize(): number {
    return this.cache?.size ?? 0
  }

  /** Prepare, call, validate, and optionally cache one System One request. */
  async ask<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: AskOptions = {},
  ): Promise<AskResult<Q>> {
    const prepared = this.prepareRequest(request)
    const cacheKey = this.cacheKey(prepared)
    if (this.cache !== undefined && options.cache !== false) {
      const cached = this.cache.get<SystemOneResult<Q>>(cacheKey)
      if (cached !== undefined) return { result: cached, cached: true }
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const linked = linkSignals(options.signal, timeout)
    let result: SystemOneResult<Q>
    try {
      const requestOptions: RequestOptions = {
        signal: linked.signal,
        timeout: this.timeoutMs,
        ...(this.retries !== undefined ? { retry: this.retries } : {}),
      }
      result = (await this.transport.systemOne(prepared, requestOptions)) as SystemOneResult<Q>
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new GuardrailsError('ABORTED', 'the Jev request was cancelled by the caller', error)
      }
      if (timeout.aborted) {
        throw new GuardrailsError('TRANSPORT', `the Jev request timed out after ${this.timeoutMs}ms`, error)
      }
      const detail = error instanceof TypeSafeError ? error.message : error instanceof Error ? error.message : String(error)
      throw new GuardrailsError('TRANSPORT', `the Jev request failed: ${detail}`, error)
    } finally {
      linked.dispose()
    }

    assertAnswers(result, prepared.questions)
    if (this.cache !== undefined && options.cache !== false) this.cache.set(cacheKey, result)
    return { result, cached: false }
  }

  private prepareRequest<Q extends Questions>(request: SystemOneRequest<Q>): SystemOneRequest<Q> {
    const model = request.model ?? this.model
    const state = this.prepareState(request.state)
    return { ...request, model, state }
  }

  private prepareState(state: SystemOneRequest['state']): SystemOneRequest['state'] {
    if (state === null) return null
    if (typeof state === 'string') {
      const redacted = this.redactor === false ? state : redactString(state, this.redactor)
      return truncateMiddle(redacted, this.maxStateChars).text
    }
    const redacted = this.redactor === false ? state : redactState(state, this.redactor)
    const serialized = stableStringify(redacted)
    if (serialized.length <= this.maxStateChars) return redacted
    return truncateMiddle(serialized, this.maxStateChars).text
  }

  private cacheKey(request: SystemOneRequest): string {
    const hash = createHash('sha256')
    hash.update(
      stableStringify({
        model: request.model,
        state: request.state,
        questions: request.questions,
      }),
    )
    return hash.digest('hex')
  }
}

interface LinkedSignal {
  signal: AbortSignal
  dispose(): void
}

function linkSignals(...signals: Array<AbortSignal | undefined>): LinkedSignal {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const signal of signals) {
    if (signal === undefined) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push({ signal, listener })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const entry of listeners) entry.signal.removeEventListener('abort', entry.listener)
    },
  }
}

function assertAnswers<Q extends Questions>(result: SystemOneResult<Q>, questions: Q): void {
  if (!isRecord(result) || !isRecord(result.answers)) {
    throw new GuardrailsError('MALFORMED', 'the Jev response did not contain an answers object')
  }
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers[name]
    if (!isRecord(answer)) {
      throw new GuardrailsError('MALFORMED', `the Jev response is missing the answer "${name}"`)
    }
    if (answer.type !== question.type) {
      throw new GuardrailsError('MALFORMED', `the Jev answer "${name}" has type "${String(answer.type)}", expected "${question.type}"`)
    }
    if (question.type === 'noul' && !isProbability(answer.noul)) {
      throw new GuardrailsError('MALFORMED', `the Jev noul answer "${name}" is not a probability`)
    }
    if (question.type === 'score' && (typeof answer.score !== 'number' || !Number.isFinite(answer.score))) {
      throw new GuardrailsError('MALFORMED', `the Jev score answer "${name}" is not finite`)
    }
    if (question.type === 'choice' && typeof answer.choice !== 'string') {
      throw new GuardrailsError('MALFORMED', `the Jev choice answer "${name}" is not a label`)
    }
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
