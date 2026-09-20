# Eval Guardrails product contract

This document fixes the interfaces between the four product pieces:

1. `@codebam/jev-guardrails` — existing guardrail library (TypeSafe/OpenRouter/local).
2. `@codebam/dsh-jev-guardrails` — existing DeepSeek Harness bundle plugin.
3. `@codebam/eval-jev-guardrails` — new client SDK + CLI + harness installers + real hooks.
4. `apps/eval-site` — hosted `eval.seanbehan.ca` service (Cloudflare Worker + D1) that owns
   the provider key, API keys, credits, and GitHub login.

## Hosted service API

Base URL: `https://eval.seanbehan.ca` (local/test base URL is configurable everywhere).

All API calls authenticate with `Authorization: Bearer eval_...`.

### POST /v1/evaluate

Body:

```json
{
  "side": "input" | "output" | "observation" | "action",
  "state": "text or JSON value",
  "action": { "tool": "Bash", "arguments": { "command": "rm -rf /" }, "workspace": "/repo" }
}
```

`action` is required only when `side === "action"`; otherwise `state` carries text.
The server selects the matching built-in battery, enforces caps (max 12,000 input
characters, known batteries only), charges one credit, calls Jev, and returns:

```json
{
  "verdict": {
    "action": "allow" | "review" | "block" | "support",
    "side": "action",
    "kind": "action",
    "hazards": { "destructive": 0.97 },
    "severity": 2.4,
    "reason": "block this tool call: ...",
    "reasons": ["..."],
    "model": "typesafe/jev-1.13-20260917",
    "usage": { "input_tokens": 900, "output_tokens": 120, "cost": 0.00004 },
    "cached": false,
    "degraded": false
  },
  "credits": { "remaining": 9999, "charged": 1 }
}
```

Credits: reserve before the provider call, refund on provider/transport failure, charge
0.1 credit for a service-side cache hit, `guard_credits` is free. A provider failure never
turns into a 5xx that loses value; the server returns a degraded verdict with fail mode and
refunds the reservation.

### POST /v1/systemone

SystemOne-shaped compatibility endpoint used by the library's `provider: "hosted"`:

```json
{ "state": "text or JSON value", "questions": { "...": { "type": "noul" } }, "model": "jev-latest" }
```

It accepts only questions whose canonical hash matches one of the built-in batteries; it
returns `{ "model": "...", "answers": {...}, "usage": {...} }`.

### GET /v1/me, GET /v1/credits

Return the authenticated account and current credit balance.

## Client package: @codebam/eval-jev-guardrails

- `EvalGuardrailsClient`: `evaluate(side, state, action?)`, `systemOne(request)`, `credits()`,
  `me()`. Reads `EVAL_API_KEY` / `EVAL_BASE_URL` env, then `~/.config/eval-jev/config.json`.
- CLI `eval-jev`:
  - `login [--token eval_...]` stores `{ "apiKey", "baseUrl" }` in
    `~/.config/eval-jev/config.json` with mode 600. Without `--token`, uses the service's
    GitHub device-flow endpoints when available.
  - `install opencode [--project|--global]` writes `tool.execute.before` plugin files.
  - `install hermes [--project|--global]` writes a real `pre_tool_call` plugin.
  - `install dsh [--profile <name>]` wires the dsh bundle with `provider: hosted`.
  - `doctor [opencode|hermes|dsh]` checks config/key/service and the installed hook files.
  - `credits` prints balance.
- Real hooks (the acceptance criterion):
  - OpenCode: plugin hook `tool.execute.before` calls `/v1/evaluate`; `block`/`support`
    throw (tool never runs), `review` is configurable (`deny` default, `allow` optional).
  - Hermes: plugin registers `pre_tool_call`; returns `{"action":"block","message":...}` for
    block/support and optionally for review; `{"action":"modify","args":...}` not used.
  - dsh: plugin bundle already uses `tools/pre-execute`; the installer selects the hosted
    provider so every tool call is evaluated.

## Library hosted provider

`@codebam/jev-guardrails` gets `provider: "hosted"`:
- Requires `apiKey` (or `EVAL_API_KEY`).
- Base URL defaults to `https://eval.seanbehan.ca`.
- `systemOne` POSTs to `/v1/systemone`; responses validate like any other provider.
- The dsh plugin's `provider: auto` resolves `EVAL_API_KEY` to `hosted`.

## Local/test mode

Every component must be testable without a real provider:
- client tests start a local `node:http` fake of `/v1/evaluate` and `/v1/systemone`;
- service tests mock the upstream Jev `fetch`;
- hook tests call the generated hook/plugin against the local fake service.
