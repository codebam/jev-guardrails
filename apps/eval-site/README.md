# eval-site — hosted guardrails service

Cloudflare Worker + D1 implementation of the hosted service in
[`docs/eval-guardrails-product.md`](../../docs/eval-guardrails-product.md).
It owns the OpenRouter/TypeSafe Jev provider key, issues `eval_...` API keys,
tracks credits, and returns guardrail verdicts for the
`@codebam/jev-guardrails` library and its hosted provider.

Live base URL: `https://eval.seanbehan.ca`

## API

All `/v1/*` routes require `Authorization: Bearer eval_...`.

| Route | Auth | Cost | Purpose |
| --- | --- | --- | --- |
| `POST /v1/evaluate` | `eval_` key | 1 credit per provider call; 0.1 credit for a service cache hit; 0 for `guard_credits` keys | Screen `input`, `output`, `observation`, or a proposed `action` with the matching built-in battery. |
| `POST /v1/systemone` | `eval_` key | 1 credit per successful call; 0 for `guard_credits` keys | SystemOne-shaped compatibility endpoint used by the library's `provider: "hosted"`. Only question sets whose canonical hash matches a built-in battery are accepted. |
| `GET /v1/me` | `eval_` key | free | Authenticated account. |
| `GET /v1/credits` | `eval_` key | free | Current credit balance and plan. |
| `POST /admin/keys` | `EVAL_ADMIN_TOKEN` as bearer | free | Mint an `eval_` key. Returns the plaintext token exactly once. |

### `POST /v1/evaluate`

```json
{
  "side": "input" | "output" | "observation" | "action",
  "state": "text or JSON value",
  "action": { "tool": "Bash", "arguments": { "command": "rm -rf /" }, "workspace": "/repo" }
}
```

`action` is required only for `side: "action"`. The server enforces the
standing cap of 12,000 serialized input characters, selects the built-in
battery for the side, reserves one credit, calls the OpenRouter Decisions API
(`POST https://openrouter.ai/api/alpha/decisions`, default model
`~typesafe/jev-latest`) with `OPENROUTER_API_KEY`, and routes the answers with
the library's policy code. Response shape:

```json
{
  "verdict": {
    "action": "allow",
    "side": "input",
    "kind": "prompt",
    "hazards": { "jailbreak": 0.02 },
    "severity": 0.2,
    "reason": "passed Jev guardrails for this prompt: no hazard above threshold",
    "reasons": [],
    "model": "typesafe/jev-1.13-20260917",
    "usage": { "input_tokens": 900, "output_tokens": 120, "cost": 0.00004 },
    "cached": false,
    "degraded": false
  },
  "credits": { "remaining": 9999, "charged": 1, "plan": "standard" }
}
```

### Credit semantics

- Evaluations reserve **1 credit** before the provider call; the reservation
  is the charge on success.
- A provider or transport failure **refunds the full reservation** and
  returns HTTP 200 with a `degraded: true` verdict whose action follows the
  library fail mode (default `open` → `allow`). The user never loses a credit
  to an upstream outage.
- A service-side cache hit (same model + state + questions within
  `EVAL_CACHE_TTL_SECONDS`) costs **0.1 credit** and returns
  `cached: true`.
- `/v1/systemone` (the compatibility path used by the library's hosted
  provider) reserves and charges one credit per successful call, with a full
  refund if the provider call fails.
- Keys created with `"plan": "guard_credits"` are **free**. This plan is for
  internal/demo keys, not for resale.
- Credits are integer micro-credits in D1 (`1 credit = 1_000_000 micro`), so
  the 0.1 cache charge is exact.

### Admin bootstrap

```bash
curl -s https://eval.seanbehan.ca/admin/keys \
  -H "Authorization: Bearer $EVAL_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"laptop","initialCredits":10000}'
```

The response contains `apiKey` (`eval_...`); store it in the client config.
Only the SHA-256 hash is persisted in D1. Optional body fields:
`userId` (attach to an existing account), `email`, `displayName`, `name`,
`plan` (`standard` or `guard_credits`), and `initialCredits`. New accounts get
10,000 credits when `initialCredits` is omitted.

## Local development

Requires Node.js 22.5+ to run the full D1-backed test suite (`node:sqlite`);
all route tests work on Node 20+.

```bash
cd apps/eval-site
npm install
cp .dev.vars.example .dev.vars   # fill in a test OpenRouter key/admin token
npx wrangler d1 migrations apply eval-guardrails-db --local
npm run typecheck
npm test
npm run dev                       # http://127.0.0.1:8787
```

`.dev.vars` is git-ignored. There is no provider key fallback in the Worker:
without `OPENROUTER_API_KEY`, `/v1/evaluate` returns a degraded fail-open
verdict with the reservation refunded, and `/v1/systemone` returns 502.

Smoke test against the local Worker:

```bash
curl -s http://127.0.0.1:8787/admin/keys \
  -H "Authorization: Bearer $(grep EVAL_ADMIN_TOKEN .dev.vars | cut -d= -f2)" \
  -H 'content-type: application/json' \
  -d '{"name":"local"}'

curl -s http://127.0.0.1:8787/v1/evaluate \
  -H "Authorization: Bearer $EVAL_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"side":"action","action":{"tool":"Bash","arguments":{"command":"rm -rf /"}}}'
```

## D1 schema and migrations

Migrations live in `migrations/` and are applied by Wrangler. The first
migration creates:

- `users` — account, plan (`standard` / `guard_credits`), credit balance;
- `api_keys` — key id, owner, prefix, SHA-256 hash, optional per-key plan,
  revocation timestamp;
- `credit_ledger` — signed grant/reserve/refund/cache-hit/adjustment rows with
  the balance after each entry;
- `evaluations` — one audit row per evaluation plus the service-side verdict
  cache (`request_hash`, `status`, `verdict_json`).

Create the database once and copy the printed id into `wrangler.toml`:

```bash
npx wrangler d1 create eval-guardrails-db
# edit wrangler.toml: database_id = "<printed id>"
```

Apply migrations to local and remote D1:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## Deploy

```bash
cd apps/eval-site
npm install
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put EVAL_ADMIN_TOKEN
npm run db:migrate:remote
npm run deploy
```

`wrangler.toml` binds D1 as `DB`, sets `compatibility_flags =
["nodejs_compat"]`, and keeps only non-secret variables in `[vars]`. Bind the
`eval.seanbehan.ca` custom domain in the Cloudflare dashboard (Workers →
your Worker → Settings → Domains & Routes) or by adding a `routes` entry to
`wrangler.toml`.

Check the bundle without deploying:

```bash
npm run deploy:dry-run
```

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — | Secret. Pays for Decisions calls; never sent to clients. |
| `EVAL_ADMIN_TOKEN` | for `/admin/keys` | — | Secret. Long random bootstrap token. |
| `OPENROUTER_MODEL` | no | `~typesafe/jev-latest` | Model alias/slug for evaluations. |
| `OPENROUTER_BASE_URL` | no | OpenRouter Decisions endpoint | Endpoint or origin override (tests/proxies). |
| `OPENROUTER_TIMEOUT_MS` | no | `15000` | Upstream request timeout, clamped to 1–120 s. |
| `EVAL_CACHE_TTL_SECONDS` | no | `3600` | Service-side verdict cache lifetime. |

## Tests and safety

`npm test` builds `dist/` and runs `node:test`. Every test injects a fake
`fetch`, so no test touches OpenRouter or any real API. The D1 store is tested
against in-memory SQLite with the real migration file; those tests skip
gracefully when `node:sqlite` is unavailable.

Known scope limits for this Worker: GitHub device-flow login (the CLI's
`login --token` path and `/admin/keys` work), billing/payments, rate limiting,
and key revocation UI are not implemented. No deploy or secret is performed
or committed by the test suite.
