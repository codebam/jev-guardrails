import assert from 'node:assert/strict'
import test from 'node:test'
import { INPUT_BATTERY, resolvePolicy, routePolicy } from '@codebam/jev-guardrails'

test('default policy routes below both thresholds to allow', () => {
  const policy = resolvePolicy('input', undefined, INPUT_BATTERY)
  const route = routePolicy({ hazards: { jailbreak: 0.1 }, severity: 0, policy })
  assert.equal(route.action, 'allow')
})

test('review threshold routes to review and action threshold to the configured action', () => {
  const policy = resolvePolicy('input', undefined, INPUT_BATTERY)
  assert.equal(routePolicy({ hazards: { jailbreak: 0.4 }, policy }).action, 'review')
  assert.equal(routePolicy({ hazards: { jailbreak: 0.8 }, policy }).action, 'block')
  assert.equal(routePolicy({ hazards: { self_harm: 0.8 }, policy }).action, 'support')
})

test('severity escalates a review to a block but preserves support', () => {
  const policy = resolvePolicy('input', undefined, INPUT_BATTERY)
  assert.equal(routePolicy({ hazards: { jailbreak: 0.4 }, severity: 2.2, policy }).action, 'block')
  assert.equal(routePolicy({ hazards: { self_harm: 0.8 }, severity: 2.9, policy }).action, 'support')
})

test('a high severity score blocks even when no hazard fires', () => {
  const policy = resolvePolicy('action', undefined, ACTION_BATTERY_FOR_TEST)
  const route = routePolicy({ hazards: {}, severity: 2.5, policy })
  assert.equal(route.action, 'block')
})

test('null ignores one hazard entirely', () => {
  const policy = resolvePolicy('input', { actions: { jailbreak: null } }, INPUT_BATTERY)
  assert.equal(routePolicy({ hazards: { jailbreak: 0.99 }, policy }).action, 'allow')
})

// Use the real action battery through the public export in the assertion above.
import { ACTION_BATTERY } from '@codebam/jev-guardrails'
const ACTION_BATTERY_FOR_TEST = ACTION_BATTERY
