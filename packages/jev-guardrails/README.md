# @codebam/jev-guardrails

Jev-backed guardrails and verification for LLM applications.

Jev is TypeSafe's System One decision model: it answers typed questions with
calibrated probabilities instead of generating text. This package turns those
answers into product actions (`allow`, `review`, `block`, `support`) under a
policy you own.

It is framework-agnostic. The DeepSeek Harness plugin lives in a separate
package and only consumes this library.

## Install

```bash
npm install @codebam/jev-guardrails
```

Node.js 20 or newer.

## Providers

| Provider | Endpoint | Credential | Default model |
| --- | --- | --- | --- |
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` via `@typesafe-ai/sdk` | `TYPESAFE_API_KEY` | `jev-latest` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` |
| `hosted` | `https://eval.seanbehan.ca/v1/systemone` | `EVAL_API_KEY` (`eval_...`) | `jev-latest` |

`hosted` is the paid `eval.seanbehan.ca` service: it owns the provider key and
meters each evaluation against prepaid credits, so callers never need a Jev key.

```ts
import { createGuardrails } from '@codebam/jev-guardrails'

const direct = createGuardrails()                       // TypeSafe
const routed = createGuardrails({ provider: 'openrouter' }) // OpenRouter Decisions API
const hosted = createGuardrails({ provider: 'hosted' })     // eval.seanbehan.ca credits
```

OpenRouter's Decisions API is not the OpenAI-compatible chat endpoint. It uses
the same `state` + typed `questions` shape as TypeSafe, so the library's
batteries work unchanged. Friendly model names are mapped:
`jev-latest` → `~typesafe/jev-latest`, `jev-1.13` → `typesafe/jev-1.13`.

## The five screens

```ts
const verdict = await guardrails.screenInput(userText)        // on the way in
const verdict = await guardrails.screenOutput(replyText)      // on the way out
const verdict = await guardrails.screenObservation(toolText)  // untrusted content
const verdict = await guardrails.assessAction(action)         // before a tool runs
const result  = await guardrails.verifyClaim({ claim, evidence, quote })
```

Each text screen returns a `GuardVerdict`:

```ts
{
  action: 'allow' | 'review' | 'block' | 'support',
  side, kind,
  hazards: { jailbreak: 0.98, harmful_request: 0.01, ... },
  topHazard: { name: 'jailbreak', probability: 0.98, label: '...' },
  severity: 1.1,             // 0-3, when the battery has a severity question
  reasons: ['jailbreak p=0.98 at or above action threshold -> block'],
  reason: 'blocked: a jailbreak ...',
  model: 'typesafe/jev-1.13-20260917',
  usage: { input_tokens, output_tokens, cost? },
  cached, degraded,
}
```

## Built-in batteries

| Battery | Hazards | Default action map |
| --- | --- | --- |
| `INPUT_BATTERY` | `jailbreak`, `harmful_request`, `medical_advice`, `self_harm`, `severity` | block, block, review, support |
| `OUTPUT_BATTERY` | `broke_policy`, `harmful_request`, `medical_advice`, `self_harm`, `severity` | block, block, review, support |
| `OBSERVATION_BATTERY` | `injection`, `hidden`, `exfiltration`, `destructive`, `secrets`, `urgency`, `severity` | block, review, block, block, review, review |
| `ACTION_BATTERY` | `destructive`, `exfiltration`, `remote_code`, `weakens_security`, `credential_access`, `outside_scope`, `consequential`, `severity` | block ×4, review, review, review |

Every battery is plain data. Copy one, change the wording, and pass it as
`batteries: { input: myBattery }`.

## Policies

The routing rule is deliberately small:

1. A hazard at or above `actionThreshold` (default `0.70`) triggers its
   configured action.
2. A hazard at or above `reviewThreshold` (default `0.35`) triggers `review`.
3. A severity score at or above `severityReview` (default `1.25`) triggers
   `review`; at or above `severityBlock` (default `2.0`) it escalates every
   `review` to `block` (without overriding `support`).
4. `precedence` picks the strongest candidate: `support > block > review > allow`.

```ts
const guardrails = createGuardrails({
  policies: {
    action: {
      actionThreshold: 0.85,
      actions: { remote_code: 'review' }, // allow legitimate installs through one extra question
      failMode: 'closed',
    },
  },
})
```

`failMode` controls a failed Jev call: `open` → `allow`, `review` → `review`,
`closed` → `block`. A degraded verdict sets `degraded: true` and an `error`.

## Local fast paths for actions

`assessAction` first runs conservative local rules. Routine read-only commands
(`ls`, `git status`, `pnpm test`, read-only tool calls) are allowed without a
model call, and obvious catastrophes (`rm -rf /`, `curl … | bash`,
`dd of=/dev/sda`, disabling security controls) are blocked locally.
Everything ambiguous goes to Jev. A local decision never overrides Jev.

Disable with `{ heuristics: false }`, or run one call with
`assessAction(action, { heuristics: false })`.

## Privacy: redaction and truncation

Before state is sent to the provider:

- known secret shapes (private keys, cloud keys, GitHub/OpenAI/Anthropic
  tokens, JWTs, bearer tokens, `password = "..."`, URL passwords, and values
  under secret-looking object keys) are replaced with `[REDACTED:...]`;
- state longer than `maxStateChars` (default 20,000) is middle-truncated so
  both the beginning and the end survive.

Disable redaction with `{ redact: false }`, or add your own patterns with
`{ redact: { extraPatterns: [...] } }`.

## Caching

For identical `state` + `questions` + `model`, answers are cached in memory for
one hour by default (500 entries). `cached: true` marks a cache hit.
Configure with `{ cache: { ttlMs, maxEntries } }` or disable with
`{ cache: false }`.

## Claim verification

```ts
const result = await guardrails.verifyClaim({
  claim: 'The export always includes archived rows.',
  evidence: 'Archived rows are omitted from exports unless include_archived is set.',
  quote: 'The export always includes archived rows.',
  autoAcceptConfidence: 0.8,
})
// result.verdict: 'supported' | 'contradicted' | 'insufficient' | 'fabricated'
// result.needsReview: true when confidence is low or the evidence is insufficient
```

If a supplied quote does not appear in the evidence (after whitespace
normalization), the verdict is `fabricated` without spending a model call.

## Low-level API

```ts
const { result, cached } = await guardrails.ask({
  state: { ticket: 'Checkout is blank.' },
  questions: {
    team: choice('Which team owns this?', { payments: 'Billing', frontend: 'Rendering' }),
    urgent: noul('Is this blocking revenue?'),
  },
})
```

`createTransport`, `JevCaller`, `resolvePolicy`, `routePolicy`,
`classifyActionLocally`, `looksLikeInjection`, and `ResponseCache` are exported
for callers that need the pieces.

## Notes and limits

- Probabilities are model output; thresholds are a product decision. Tune them
  against your own labeled examples before enforcing.
- A guardrail is not a sandbox. Keep OS/container isolation, tool allowlists,
  and human approval for dangerous operations.
- Sending prompts and tool arguments to a third-party API is a data-flow
  decision; use redaction and review your provider's retention policy.

## License

MIT © 2026 Sean Behan
