#!/usr/bin/env node
/**
 * Idempotently create the four Eval Guardrails credit products/prices.
 *
 * Reads the Stripe secret from apps/eval-site/.dev.vars (or a path passed as
 * argv[2]), creates missing products/prices in the key's mode (test or live),
 * and writes the public `price_...` ids back to `.dev.vars`. The secret is
 * never printed.
 *
 * Usage: node scripts/stripe-setup.mjs [path/to/.dev.vars]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const varsPath = process.argv[2] !== undefined ? resolve(process.argv[2]) : join(appDir, '.dev.vars')
if (!existsSync(varsPath)) {
  console.error(`stripe-setup: ${varsPath} does not exist. Create it from .dev.vars.example first.`)
  process.exit(1)
}

const original = readFileSync(varsPath, 'utf8')
const env = parseEnv(original)
const secretKey = env.STRIPE_SECRET_KEY
if (secretKey === undefined || secretKey.length === 0) {
  console.error('stripe-setup: STRIPE_SECRET_KEY is missing from .dev.vars')
  process.exit(1)
}
const mode = secretKey.startsWith('sk_live_') ? 'LIVE' : secretKey.startsWith('sk_test_') ? 'test' : 'unknown'
const apiBase = 'https://api.stripe.com'

/** The four packs, matching docs/pricing.md. */
const PACKS = [
  { id: 'p5000', credits: 5000, amount: 1500, name: 'Eval Guardrails — 5,000 credits', nickname: '5,000 evaluations' },
  { id: 'p25000', credits: 25000, amount: 5900, name: 'Eval Guardrails — 25,000 credits', nickname: '25,000 evaluations' },
  { id: 'p100000', credits: 100000, amount: 19900, name: 'Eval Guardrails — 100,000 credits', nickname: '100,000 evaluations' },
  { id: 'p500000', credits: 500000, amount: 79900, name: 'Eval Guardrails — 500,000 credits', nickname: '500,000 evaluations' },
]

function parseEnv(text) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''))
  }
  return Object.fromEntries(out)
}

async function stripe(method, path, form) {
  const url = new URL(`${apiBase}${path}`)
  const init = {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      accept: 'application/json',
    },
  }
  if (method === 'GET') {
    for (const [key, value] of Object.entries(form ?? {})) url.searchParams.set(key, String(value))
  } else {
    init.headers['content-type'] = 'application/x-www-form-urlencoded'
    init.body = new URLSearchParams(form).toString()
  }
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try { body = text.length > 0 ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.error?.type ?? `HTTP ${response.status}`
    throw new Error(`Stripe ${method} ${path} failed: ${message}`)
  }
  return body
}

async function listAll(path, query) {
  const items = []
  let startingAfter
  for (;;) {
    const page = await stripe('GET', path, { ...query, limit: 100, ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}) })
    const data = Array.isArray(page.data) ? page.data : []
    items.push(...data)
    if (page.has_more !== true || data.length === 0) break
    startingAfter = data[data.length - 1].id
  }
  return items
}

function productMatches(product, pack) {
  const metadata = product.metadata ?? {}
  return metadata.app === 'eval-guardrails' && metadata.pack === pack.id
}

function priceMatches(price, productId, pack) {
  return price.active !== false && price.product === productId && price.currency === 'cad' && price.unit_amount === pack.amount
}

async function ensurePack(pack, products) {
  let product = products.find((candidate) => productMatches(candidate, pack))
  let productStatus = 'reused'
  if (product === undefined) {
    product = await stripe('POST', '/v1/products', {
      name: pack.name,
      description: `${pack.credits.toLocaleString('en-CA')} Eval Guardrails evaluation credits`,
      'metadata[app]': 'eval-guardrails',
      'metadata[pack]': pack.id,
      'metadata[credits]': String(pack.credits),
    })
    productStatus = 'created'
    products.push(product)
  }

  const prices = await listAll('/v1/prices', { product: product.id })
  let price = prices.find((candidate) => priceMatches(candidate, product.id, pack))
  let priceStatus = 'reused'
  if (price === undefined) {
    price = await stripe('POST', '/v1/prices', {
      product: product.id,
      currency: 'cad',
      unit_amount: String(pack.amount),
      nickname: pack.nickname,
      'metadata[app]': 'eval-guardrails',
      'metadata[pack]': pack.id,
      'metadata[credits]': String(pack.credits),
    })
    priceStatus = 'created'
  }
  return { product, productStatus, price, priceStatus }
}

const packs = PACKS.map((pack) => ({ ...pack, key: `STRIPE_PRICE_${pack.id.toUpperCase().replace(/^P/, 'P')}` }))
const products = await listAll('/v1/products', { active: true })

const results = []
for (const pack of packs) {
  try {
    results.push({ pack, ...(await ensurePack(pack, products)) })
  } catch (error) {
    console.error(`stripe-setup: ${pack.id}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.exitCode === 1) {
  console.error('stripe-setup: one or more packs failed; .dev.vars was not modified.')
  process.exit(1)
}

// Upsert the public price ids into .dev.vars, preserving every other line.
let next = original
for (const { pack, price } of results) {
  next = upsertLine(next, pack.key, `price_${price.id.replace(/^price_/, '')}`)
}
writeFileSync(varsPath, next, { mode: 0o600 })

console.log(`stripe-setup: Stripe mode ${mode}`)
console.log('pack       amount      product     price       status')
for (const { pack, product, productStatus, price, priceStatus } of results) {
  console.log(
    `${pack.id.padEnd(10)} CA$${(pack.amount / 100).toFixed(2).padEnd(8)} ${product.id.padEnd(11)} ${price.id.padEnd(11)} ` +
    `${productStatus}/${priceStatus}`,
  )
}
console.log(`stripe-setup: wrote ${results.length} ${mode === 'LIVE' ? 'live' : 'test'} price ids to .dev.vars`)
console.log('stripe-setup: set EVAL_PUBLIC_URL=https://eval.seanbehan.ca before deploying the Worker; localhost is local-only.')

function upsertLine(text, key, value) {
  const lines = text.split(/\r?\n/)
  let found = false
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith(`${key}=`)) {
      lines[index] = `${key}=${value}`
      found = true
    }
  }
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n')
}
