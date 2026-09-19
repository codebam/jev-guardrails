import assert from 'node:assert/strict'
import test from 'node:test'
import { ResponseCache } from '@codebam/jev-guardrails'

test('returns a stored value before the TTL expires', () => {
  let now = 1000
  const cache = new ResponseCache({ ttlMs: 100, maxEntries: 2 }, () => now)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
  now = 1099
  assert.equal(cache.get('a'), 1)
  now = 1101
  assert.equal(cache.get('a'), undefined)
})

test('evicts the least recently used entry', () => {
  const cache = new ResponseCache({ ttlMs: 1000, maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})
