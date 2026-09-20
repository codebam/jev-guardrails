/**
 * Stripe Checkout credit packs and webhook verification.
 *
 * Dependency-free: uses `fetch` for the Stripe REST API and WebCrypto HMAC
 * for `Stripe-Signature` verification, so the Worker bundle stays clean.
 */
import { constantTimeEqual, hmacSha256Hex } from './crypto.js'
import type { Env } from './types.js'

/** Credits sold per pack, matching docs/pricing.md. */
export const STRIPE_PACKS = {
  p5000: 5_000,
  p25000: 25_000,
  p100000: 100_000,
  p500000: 500_000,
} as const

/** Pack ids accepted by `/v1/billing/checkout`. */
export type StripePack = keyof typeof STRIPE_PACKS

/** True for a known credit pack id. */
export function isStripePack(value: unknown): value is StripePack {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STRIPE_PACKS, value)
}

/** Failure talking to Stripe, or missing Stripe configuration. */
export class StripeError extends Error {
  readonly status: number
  readonly body: string
  /** Error-envelope code; defaults to `stripe_error`. */
  readonly code: string

  constructor(status: number, message: string, body = '', code = 'stripe_error') {
    super(message)
    this.name = 'StripeError'
    this.status = status
    this.body = body
    this.code = code
  }
}

/**
 * Client contract; injected into the app so tests can mock upstream fetch.
 *
 * `promotionCode` is the buyer-entered code; when present it is resolved to a
 * Stripe promotion-code id and passed as an explicit discount. When absent,
 * Checkout's own promotion-code field is enabled unless
 * `EVAL_ALLOW_PROMOTION_CODES=false`.
 */
export interface StripeClient {
  createCheckoutSession(
    env: Env,
    input: { userId: string; pack: StripePack; promotionCode?: string },
  ): Promise<{ url: string; id: string }>
}

/** Parsed Stripe event used by the webhook. */
export interface StripeEvent {
  id: string
  type: string
  object: Record<string, unknown>
}

const CHECKOUT_SESSIONS_URL = 'https://api.stripe.com/v1/checkout/sessions'
const PROMOTION_CODES_URL = 'https://api.stripe.com/v1/promotion_codes'
const DEFAULT_PUBLIC_URL = 'https://eval.seanbehan.ca'
const PROMOTION_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const PRICE_ENV = {
  p5000: 'STRIPE_PRICE_P5000',
  p25000: 'STRIPE_PRICE_P25000',
  p100000: 'STRIPE_PRICE_P100000',
  p500000: 'STRIPE_PRICE_P500000',
} as const satisfies Record<StripePack, keyof Env>

/** Build a Stripe client backed by the supplied `fetch`. */
export function createStripeClient(fetchImpl: typeof globalThis.fetch): StripeClient {
  return {
    async createCheckoutSession(env, input) {
      const secret = env.STRIPE_SECRET_KEY?.trim()
      if (secret === undefined || secret.length === 0) {
        throw new StripeError(500, 'STRIPE_SECRET_KEY is not configured')
      }
      const priceId = env[PRICE_ENV[input.pack]]?.trim()
      if (priceId === undefined || priceId.length === 0) {
        throw new StripeError(500, `${PRICE_ENV[input.pack]} is not configured`)
      }
      const baseUrl = (env.EVAL_PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')
      const credits = STRIPE_PACKS[input.pack]
      const formValues: Record<string, string> = {
        mode: 'payment',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?checkout=cancelled`,
        'metadata[userId]': input.userId,
        'metadata[credits]': String(credits),
        'metadata[pack]': input.pack,
      }

      if (input.promotionCode !== undefined) {
        // An explicit code is resolved to a promotion-code id. Stripe rejects
        // `allow_promotion_codes` together with `discounts`, so only one of
        // the two parameters may be sent.
        const code = input.promotionCode.trim()
        if (!PROMOTION_CODE_PATTERN.test(code)) {
          throw new StripeError(
            400,
            'promotionCode must be 1-64 characters of letters, numbers, "_" or "-".',
            '',
            'invalid_promotion_code',
          )
        }
        formValues['discounts[0][promotion_code]'] = await lookupPromotionCode(fetchImpl, secret, code)
      } else if (allowPromotionCodes(env)) {
        formValues.allow_promotion_codes = 'true'
      }

      const form = new URLSearchParams(formValues)

      let response: Response
      try {
        response = await fetchImpl(CHECKOUT_SESSIONS_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secret}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: form.toString(),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new StripeError(502, `Stripe Checkout request failed: ${message}`)
      }

      const text = await response.text().catch(() => '')
      let body: unknown = null
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          throw new StripeError(502, `Stripe Checkout returned invalid JSON (${response.status})`, text.slice(0, 300))
        }
      }
      if (!response.ok) {
        throw new StripeError(response.status, `Stripe Checkout request failed (${response.status})${stripeMessage(body)}`, text.slice(0, 300))
      }
      if (!isRecord(body) || typeof body.url !== 'string' || body.url.length === 0 || typeof body.id !== 'string' || body.id.length === 0) {
        throw new StripeError(502, 'Stripe Checkout response is missing url or id', text.slice(0, 300))
      }
      return { url: body.url, id: body.id }
    },
  }
}

/** True unless the operator explicitly disabled Checkout's code input. */
function allowPromotionCodes(env: Env): boolean {
  return env.EVAL_ALLOW_PROMOTION_CODES?.trim() !== 'false'
}

/**
 * Resolve a buyer-entered promotion code to its Stripe promotion-code id.
 *
 * Unknown/inactive codes are a 400 `invalid_promotion_code`; a failed lookup
 * (transport, non-2xx, malformed response) is a 502 `stripe_error`.
 */
async function lookupPromotionCode(
  fetchImpl: typeof globalThis.fetch,
  secret: string,
  code: string,
): Promise<string> {
  const url = new URL(PROMOTION_CODES_URL)
  url.searchParams.set('code', code)
  url.searchParams.set('active', 'true')
  url.searchParams.set('limit', '1')

  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${secret}`,
        accept: 'application/json',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new StripeError(502, `Stripe promotion-code lookup failed: ${message}`)
  }

  const text = await response.text().catch(() => '')
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new StripeError(
        502,
        `Stripe promotion-code lookup returned invalid JSON (${response.status})`,
        text.slice(0, 300),
      )
    }
  }
  if (!response.ok) {
    throw new StripeError(
      502,
      `Stripe promotion-code lookup failed (${response.status})${stripeMessage(body)}`,
      text.slice(0, 300),
    )
  }

  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null
  const first = data?.find(isRecord)
  const id = first !== undefined && typeof first.id === 'string' && first.id.length > 0 ? first.id : null
  if (id === null || first?.active === false) {
    throw new StripeError(400, 'That promotion code is unknown, expired, or inactive.', '', 'invalid_promotion_code')
  }
  return id
}

/**
 * Verify `Stripe-Signature` over the raw body. Implements the documented
 * `t=...,v1=...` scheme with a replay tolerance (default 300 s).
 */
export async function verifyStripeSignature(input: {
  secret: string
  header: string | null
  payload: string
  nowSeconds: number
  toleranceSeconds?: number
}): Promise<boolean> {
  const parsed = parseSignatureHeader(input.header)
  if (parsed === null) return false
  const tolerance = input.toleranceSeconds ?? 300
  if (!Number.isFinite(input.nowSeconds) || Math.abs(input.nowSeconds - parsed.timestamp) > tolerance) return false
  const expected = await hmacSha256Hex(input.secret, `${parsed.timestamp}.${input.payload}`)
  let valid = false
  for (const signature of parsed.signatures) {
    if (await constantTimeEqual(signature.toLowerCase(), expected)) valid = true
  }
  return valid
}

/** Parse the raw webhook event shape used by the service. */
export function parseStripeEvent(rawBody: string): StripeEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const data = isRecord(parsed.data) ? parsed.data : null
  const object = data !== null && isRecord(data.object) ? data.object : null
  if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string' || object === null) return null
  return { id: parsed.id, type: parsed.type, object }
}

interface ParsedSignatureHeader {
  timestamp: number
  signatures: string[]
}

function parseSignatureHeader(header: string | null): ParsedSignatureHeader | null {
  if (header === null) return null
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const trimmed = part.trim()
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator)
    const value = trimmed.slice(separator + 1)
    if (key === 't') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) timestamp = parsed
    } else if (key === 'v1' && /^[0-9a-fA-F]+$/.test(value)) {
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripeMessage(body: unknown): string {
  if (!isRecord(body)) return ''
  const error = isRecord(body.error) ? body.error : null
  const message = error?.message ?? body.message
  return typeof message === 'string' && message.length > 0 ? `: ${message}` : ''
}
