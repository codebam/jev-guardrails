import assert from 'node:assert/strict'
import test from 'node:test'
import { createGuardrails } from '@codebam/jev-guardrails'
import { choiceAnswer, fakeTransport } from './helpers.mjs'

function verificationTransport(choice, confidence, probabilities) {
  return fakeTransport({
    answerFor: {
      relationship: choiceAnswer(choice, probabilities ?? {
        supported: choice === 'supported' ? confidence : 0.05,
        contradicted: choice === 'contradicted' ? confidence : 0.05,
        insufficient: choice === 'insufficient' ? confidence : 0.05,
      }, confidence),
    },
  })
}

test('marks a quote that is absent from the evidence as fabricated without a model call', async () => {
  const transport = fakeTransport({ answerFor: {} })
  const guardrails = createGuardrails({ client: transport })
  const verdict = await guardrails.verifyClaim({
    claim: 'The token is revoked after logout.',
    evidence: 'The token remains valid until it expires.',
    quote: 'The token is revoked after logout.',
  })
  assert.equal(verdict.verdict, 'fabricated')
  assert.equal(verdict.method, 'string-match')
  assert.equal(verdict.needsReview, true)
  assert.equal(transport.calls.length, 0)
})

test('verifies a supported claim with high confidence', async () => {
  const transport = verificationTransport('supported', 0.94, { supported: 0.94, contradicted: 0.01, insufficient: 0.05 })
  const guardrails = createGuardrails({ client: transport })
  const verdict = await guardrails.verifyClaim({
    claim: 'The service returns 404 for unknown users.',
    evidence: 'Unknown user identifiers produce an HTTP 404 response.',
  })
  assert.equal(verdict.verdict, 'supported')
  assert.equal(verdict.needsReview, false)
  assert.equal(verdict.confidence, 0.94)
  assert.match(verdict.reason, /supports the claim/)
  assert.equal(transport.calls.length, 1)
})

test('marks low-confidence support as needing review', async () => {
  const transport = verificationTransport('supported', 0.55, { supported: 0.55, contradicted: 0.2, insufficient: 0.25 })
  const guardrails = createGuardrails({ client: transport })
  const verdict = await guardrails.verifyClaim({ claim: 'A', evidence: 'B', autoAcceptConfidence: 0.8 })
  assert.equal(verdict.verdict, 'supported')
  assert.equal(verdict.needsReview, true)
  assert.match(verdict.reason, /below the acceptance threshold/)
})

test('marks an insufficient verdict for review', async () => {
  const transport = verificationTransport('insufficient', 0.98, { supported: 0.01, contradicted: 0.01, insufficient: 0.98 })
  const guardrails = createGuardrails({ client: transport })
  const verdict = await guardrails.verifyClaim({ claim: 'The moon is made of cheese.', evidence: 'This document is about bread.' })
  assert.equal(verdict.verdict, 'insufficient')
  assert.equal(verdict.needsReview, true)
})

test('rejects an empty claim', async () => {
  const guardrails = createGuardrails({ client: fakeTransport({ answerFor: {} }) })
  await assert.rejects(() => guardrails.verifyClaim({ claim: '   ' }), /non-empty claim/)
})
