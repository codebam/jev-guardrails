import assert from 'node:assert/strict'
import test from 'node:test'
import { contentToText, formatProbability, stableStringify, truncateMiddle } from '@codebam/jev-guardrails'

test('stableStringify sorts keys recursively', () => {
  const a = stableStringify({ z: 1, a: { y: 2, b: 3 } })
  const b = stableStringify({ a: { b: 3, y: 2 }, z: 1 })
  assert.equal(a, b)
})

test('stableStringify drops undefined object values but keeps null', () => {
  assert.equal(stableStringify({ a: undefined, b: null }), '{"b":null}')
})

test('truncateMiddle keeps both ends', () => {
  const result = truncateMiddle(`start-${'x'.repeat(500)}-end`, 120)
  assert.equal(result.truncated, true)
  assert.match(result.text, /^start-/)
  assert.match(result.text, /-end$/)
  assert.match(result.text, /truncated 4\d\d characters/)
})

test('contentToText flattens dsh content blocks', () => {
  assert.equal(
    contentToText([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-result', content: [{ type: 'text', text: 'result' }] },
    ]),
    'hello\nthinking\nresult',
  )
})

test('formatProbability renders a percentage', () => {
  assert.equal(formatProbability(0.955), '96%')
  assert.equal(formatProbability(Number.NaN), 'n/a')
})
