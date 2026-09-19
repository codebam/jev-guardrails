import assert from 'node:assert/strict'
import test from 'node:test'
import { redactState, redactString } from '@codebam/jev-guardrails'

test('redacts an OpenAI-style key', () => {
  const key = `sk-${'a'.repeat(32)}`
  const output = redactString(`use ${key} to call the API`)
  assert.equal(output.includes(key), false)
  assert.match(output, /\[REDACTED:(api-key|assigned-secret)\]/)
})

test('redacts an AWS access key and a GitHub token', () => {
  const output = redactString('AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  assert.equal(output.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.match(output, /\[REDACTED:aws-access-key\]/)
  assert.match(output, /\[REDACTED:github-token\]/)
})

test('redacts a private key block without leaking its body', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`
  const output = redactString(`here it is:\n${pem}\ndone`)
  assert.equal(output.includes('MIIEowIBAAKCAQEA'), false)
  assert.match(output, /\[REDACTED:private-key\]/)
  assert.match(output, /^here it is:/)
})

test('preserves assignment names while hiding values', () => {
  const output = redactString('DATABASE_PASSWORD = "supersecretvalue123"')
  assert.equal(output.includes('supersecretvalue123'), false)
  assert.match(output, /\[REDACTED:assigned-secret\]/)
})

test('redacts URL passwords and bearer tokens', () => {
  const output = redactString('fetch https://user:hunter2@example.com with Bearer abcdefghijklmnopqrstuvwxyz')
  assert.equal(output.includes('hunter2'), false)
  assert.equal(output.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.match(output, /\[REDACTED:url-password\]/)
  assert.match(output, /\[REDACTED:bearer-token\]/)
})

test('leaves ordinary prose and short words alone', () => {
  const text = 'The password field is empty and the token bucket is full.'
  assert.equal(redactString(text), text)
})

test('redactState maps nested structures and preserves shape', () => {
  const input = {
    note: 'prefix AKIAIOSFODNN7EXAMPLE suffix',
    nested: ['sk-' + 'b'.repeat(32), { password: 'another-secret-value' }],
    count: 3,
  }
  const output = redactState(input)
  assert.equal(output.count, 3)
  assert.equal(output.note.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(output.nested[0].includes('sk-b'), false)
  assert.equal(output.nested[1].password, '[REDACTED:assigned-secret]')
})
