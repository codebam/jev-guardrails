# @codebam/dsh-jev-guardrails

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that uses [`@codebam/jev-guardrails`](../jev-guardrails) to score risk before an
action is taken.

The plugin contains no question wording and no routing logic of its own. It
translates Cordis configuration and harness decisions into library calls, and
it traps every runtime failure so a guardrail cannot take down a turn.

## What it intercepts

| Harness seam | When | What the library does |
| --- | --- | --- |
| `agent/pre-step` | before a human prompt reaches the model | `screenInput` for jailbreaks, harmful requests, self-harm signals |
| `tools/pre-execute` | before a tool call executes | `assessAction` for destructive, exfiltration, remote-code, security, credential, scope, and consequential risk |
| `tools/post-execute` | before a tool result becomes model context | `screenObservation` for prompt injection, hidden instructions, embedded secrets |
| `session/event` + `agent/turn-stopping` | when a response is about to finish | `screenOutput`; optionally steer a corrected response |

## Install

The package is a dsh **bundle**: it declares `dsh.bundle.patch`, ships its own
`cordis.patch.yml`, and appears in the Plugins page once selected. Install it
from the Web **Plugins → Add plugin** dialog with the spec
`@codebam/dsh-jev-guardrails`; the dialog runs the same package operation as
`dsh plugin` and selects the bundle for the active profile.

The bundle's patch inserts one row, `id: jev-guardrails`, with the default
configuration:

```yaml
- insert:
    - id: jev-guardrails
      name: '@codebam/dsh-jev-guardrails'
      config:
        provider: auto
        input: block
        actions: enforce
        observations: suspicious
        outputs: off
```

Override any field by adding a row with the same `id` to the profile's own
`cordis.patch.yml`. The plugin resolves `tools` before mounting; if no provider
key is available it logs a warning and leaves the profile running.

> **Upgrading from 0.1.0:** that version declared no `dsh.bundle`, so dsh
> installed it as a plain dependency and the Plugins page did not list it.
> Publish/install `0.1.1` or later, then remove the old plain dependency if it
> is still in the profile (`dsh plugin --profile <profile> remove
> @codebam/dsh-jev-guardrails`) and add it again from the Plugins page. The
> bundle patch then inserts the row and the toggle appears under **Installed**.

## Providers and keys

`provider` defaults to `auto`:

1. explicit `apiKey` starting with `sk-or-` → OpenRouter;
2. otherwise `TYPESAFE_API_KEY` → TypeSafe System One API;
3. otherwise `OPENROUTER_API_KEY` → OpenRouter Decisions API;
4. otherwise TypeSafe (the plugin then disables itself with a warning).

On the author's dsh hosts the launcher exports `OPENROUTER_API_KEY` from
`/run/secrets/openrouter-api-key`, so OpenRouter is selected automatically and
no key is written into the profile. Force a provider explicitly with
`provider: typesafe` or `provider: openrouter`.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | `auto` | `auto`, `typesafe`, or `openrouter`. |
| `apiKey` | — | Provider key; otherwise the provider environment variable. |
| `baseURL` | provider default | Gateway or test endpoint. |
| `model` | provider default | `jev-latest` (TypeSafe) or `~typesafe/jev-latest` (OpenRouter). |
| `sessionId` | — | Optional OpenRouter session id for observability grouping. |
| `input` | `block` | `off`, `observe`, `warn`, or `block`. |
| `inputBlockStyle` | `reject` | `reject` stops the turn; `notice` replaces the prompt with a plugin notice so the model can explain the block. |
| `actions` | `enforce` | `off`, `observe`, or `enforce`. |
| `onActionReview` | `ask` | `ask`, `deny`, or `allow`. |
| `onActionBlock` | `deny` | `deny` or `ask`. |
| `observations` | `suspicious` | `off`, `observe`, `suspicious` (local heuristic gate, then Jev), or `all`. |
| `outputs` | `off` | `off`, `observe`, or `steer` (one correction attempt per turn). |
| `heuristics` | `true` | Local fast paths for routine and obviously dangerous tool calls. |
| `reviewThreshold` | `0.35` | Hazard probability that routes to review. |
| `actionThreshold` | `0.70` | Hazard probability that triggers its configured action. |
| `severityReview` | `1.25` | Severity score (0-3) that routes to review. |
| `severityBlock` | `2.0` | Severity score that escalates a review to a block. |
| `failMode` | `open` | `open` (allow), `review`, or `closed` (block) when Jev fails. |
| `unknownHazardAction` | `review` | Action for a hazard without an explicit rule. |
| `actionRules` | — | Per-hazard overrides, e.g. `{ remote_code: review }`. |
| `cacheTtlMs` | `3600000` | Cached answer lifetime; `0` disables. |
| `cacheMaxEntries` | `500` | Maximum cached answers. |
| `maxStateChars` | `20000` | Middle-truncation limit for state sent to Jev. |
| `redact` | `true` | Redact known secret shapes before sending state. |
| `timeoutMs` | `5000` | Per-request timeout. |
| `skipTools` | `[]` | Exact tool names never screened. |
| `guardTools` | all | When set, only these exact tool names are screened. |
| `log` | `decisions` | `off`, `decisions`, or `verbose`. |

## Decision mapping

The library returns `allow`, `review`, `block`, or `support`.

| Library action | Input | Tool call | Tool result | Response |
| --- | --- | --- | --- | --- |
| `allow` | pass | pass | pass | pass |
| `review` | append warning context | `onActionReview` (`ask` by default) | accept with warning context | steer when `outputs: steer` |
| `block` | reject/notice | `onActionBlock` (`deny` by default) | block with corrective feedback | steer when `outputs: steer` |
| `support` | reject/notice | `onActionBlock` | block with corrective feedback | steer when `outputs: steer` |

A denial or block reason is written into the model-facing result. It names the
finding and closes the obvious workaround: do not retry, do not route around
the guardrail, tell the user what was blocked.

## Behavior notes

- **Local fast paths come first for tool calls.** `pnpm test` needs no API
  call; `curl … | bash` is blocked without one. Ambiguous calls go to Jev.
- **Tool-result screening is gated by default.** `observations: suspicious`
  only calls Jev when the local injection heuristic fires. Use `all` to screen
  every non-empty result, or `observe` to log without enforcing.
- **Output steering is off by default** because it adds one Jev call and
  possibly one model turn per response. Set `outputs: steer` to verify final
  responses and ask for a correction once per turn.
- **Fail mode defaults to open.** A guardrail service outage should not brick
  the harness; set `failMode: closed` when blocking is more important than
  availability.
- **Secrets are redacted by default** before state leaves the process.

## Layout

```
index.mjs            Cordis plugin entry (name, inject, Config, apply)
src/config.mjs       defaults, schema, normalization, library option translation
src/runtime.mjs      the four harness interception listeners
src/messages.mjs     plugin-sourced notices and dsh message helpers
test/                fake-context, fake-provider, and local-HTTP tests
```

## Example: strict local profile

```yaml
- name: '@codebam/dsh-jev-guardrails'
  config:
    provider: openrouter
    input: block
    actions: enforce
    onActionReview: deny
    onActionBlock: deny
    observations: suspicious
    outputs: steer
    failMode: closed
    severityBlock: 1.75
    actionRules:
      remote_code: review
```

## Limitations

- The plugin is a policy layer, not a sandbox or an authorization system. Keep
  OS/container isolation, tool allowlists, and human approval for dangerous
  operations.
- Local heuristics are intentionally conservative but incomplete; they are
  fast paths, not security boundaries.
- `outputs: steer` asks the model for a correction. It cannot retract content
  the user already saw in a streaming client; use input/tool/output blocks and
  the client's own rendering for hard guarantees.
- The input notice path creates a plugin-sourced message; review your threat
  model if untrusted text can reach that path.

## License

MIT © 2026 Sean Behan
