# eval-site — hosted guardrails service

Cloudflare Worker + D1 implementation of the hosted service in
[`docs/eval-guardrails-product.md`](../../docs/eval-guardrails-product.md).
It owns the OpenRouter/TypeSafe Jev provider key, issues `eval_...` API keys,
tracks credits, runs GitHub device-flow login, sells Stripe credit packs, and
returns guardrail verdicts for the `@codebam/jev-guardrails` library and its
hosted provider.

Live base URL: `https://eval.seanbehan.ca`

## API

`/v1/auth/*` routes are public; every other `/v1/*` route requires
`Authorization: Bearer eval_...`.

| Route | Auth | Cost | Purpose |
| --- | --- | --- | --- |
| `POST /v1/auth/device` | none | free | Start a GitHub device-flow login and return the device/user codes. |
| `POST /v1/auth/device/token` | none | free | Poll GitHub; on success creates/returns the account and mints an `eval_` key. |
| `POST /v1/evaluate` | `eval_` key | 1 credit per provider call; 0.1 credit for a service cache hit; 0 for `guard_credits` keys | Screen `input`, `output`, `observation`, or a proposed `action` with the matching built-in battery. |
| `POST /v1/systemone` | `eval_` key | 1 credit per successful call; 0 for `guard_credits` keys | SystemOne-shaped compatibility endpoint used by the library's `provider: "hosted"`. Only question sets whose canonical hash matches a built-in battery are accepted. |
| `GET /v1/me` | `eval_` key | free | Authenticated account. |
| `GET /v1/credits` | `eval_` key | free | Current credit balance and plan. |
| `POST /v1/billing/checkout` | `eval_` key | free | Create a Stripe Checkout Session for a credit pack. |
| `POST /stripe/webhook` | Stripe signature | free | Verify and process Stripe webhooks; grants pack credits exactly once. |
| `POST /admin/keys` | `EVAL_ADMIN_TOKEN` as bearer | free | Mint an `eval_` key outside GitHub login. Returns the plaintext token exactly once. |

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
- A first GitHub login grants `EVAL_FREE_CREDITS` (default **250**) once per
  account; returning logins get a new key but no second grant.
- Purchased credit packs (below) grant their credits when Stripe reports a
  completed, paid Checkout Session.
- Credits are integer micro-credits in D1 (`1 credit = 1_000_000 micro`), so
  the 0.1 cache charge is exact.

### GitHub device login

The service uses GitHub's **device flow**, which is a public-client flow: no
client secret exists on the Worker. Configure `GITHUB_CLIENT_ID` (public OAuth
app client id) and enable device flow in the GitHub OAuth app settings.

```bash
# 1. Start: CLI sends the public client id (or omits it to use the server's).
curl -s http://127.0.0.1:8787/v1/auth/device \
  -H 'content-type: application/json' \
  -d '{"client_id":"'"$GITHUB_CLIENT_ID"'","scope":"read:user user:email"}'
# -> { "device_code", "user_code", "verification_uri",
#      "verification_uri_complete", "expires_in", "interval" }

# 2. Poll with the device_code (repeat at `interval` seconds):
curl -s http://127.0.0.1:8787/v1/auth/device/token \
  -H 'content-type: application/json' \
  -d '{"device_code":"...","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}'
# Pending -> HTTP 200 { "error": "authorization_pending", ... }  (verbatim)
# Success -> HTTP 200 { "apiKey": "eval_...", "login": "octocat", "credits": 250 }
```

Polling states (`authorization_pending`, `slow_down`, `expired_token`,
`access_denied`) are passed through verbatim with HTTP 200 so the CLI can keep
polling. On success the service reads `https://api.github.com/user` (and
`/user/emails` for a verified email when needed), upserts the account by
`github_id`, mints an `eval_` key, and returns it. The GitHub access token is
used in memory only: it is never logged, persisted, or returned to the client.

### Stripe credit packs

Packs and credit amounts match [`docs/pricing.md`](../../docs/pricing.md):

| Pack | Credits | Stripe price env |
| --- | ---: | --- |
| `p5000` | 5,000 | `STRIPE_PRICE_P5000` |
| `p25000` | 25,000 | `STRIPE_PRICE_P25000` |
| `p100000` | 100,000 | `STRIPE_PRICE_P100000` |
| `p500000` | 500,000 | `STRIPE_PRICE_P500000` |

Create a Checkout Session for the authenticated account:

```bash
curl -s http://127.0.0.1:8787/v1/billing/checkout \
  -H "Authorization: Bearer $EVAL_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"pack":"p5000"}'
# -> { "url": "https://checkout.stripe.com/...", "id": "cs_..." }
```

The Worker creates the session at `https://api.stripe.com/v1/checkout/sessions`
with `mode=payment`, the pack's price id, `success_url`/`cancel_url` under
`EVAL_PUBLIC_URL`, and `metadata {userId, credits, pack}`. It returns only
`{url, id}` to the client.

Stripe calls `POST /stripe/webhook` with `checkout.session.completed`; the
Worker verifies the raw body with the `Stripe-Signature` HMAC-SHA256 header
using `STRIPE_WEBHOOK_SECRET` (WebCrypto, 300 s replay tolerance), rejects bad
signatures with 400, and grants the metadata credits **exactly once** using the
`stripe_events` idempotency table. Unrelated and unpaid events are ignored with
HTTP 200.

For local webhook testing:

```bash
stripe login
stripe listen --forward-to http://127.0.0.1:8787/stripe/webhook
# copy the printed whsec_... into .dev.vars as STRIPE_WEBHOOK_SECRET
```

In the Stripe Dashboard, add `https://eval.seanbehan.ca/stripe/webhook` as a
webhook endpoint subscribed to `checkout.session.completed`.

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
cp .dev.vars.example .dev.vars   # fill in provider/admin/GitHub/Stripe values
npx wrangler d1 migrations apply eval-guardrails-db --local
npm run check                     # typecheck + tests
npm run dev                       # http://127.0.0.1:8787
```

`.dev.vars` is git-ignored. There is no provider key fallback in the Worker:
without `OPENROUTER_API_KEY`, `/v1/evaluate` returns a degraded fail-open
verdict with the reservation refunded, and `/v1/systemone` returns 502.
Missing GitHub/Stripe configuration fails those routes with an explicit
`github_not_configured` / `stripe_error` / `webhook_not_configured` error; the
guardrail routes keep working.

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

Migrations live in `migrations/` and are applied by Wrangler:

- `0001_init.sql`
  - `users` — account, plan (`standard` / `guard_credits`), credit balance;
  - `api_keys` — key id, owner, prefix, SHA-256 hash, optional per-key plan,
    revocation timestamp;
  - `credit_ledger` — signed grant/reserve/refund/cache-hit/adjustment rows
    with the balance after each entry;
  - `evaluations` — one audit row per evaluation plus the service-side verdict
    cache (`request_hash`, `status`, `verdict_json`).
- `0002_github_identity.sql`
  - adds `users.github_id` with a unique index for device-flow login;
  - creates `stripe_events` — the exactly-once idempotency ledger for Stripe
    webhook grants (`id`, `type`, `session_id`, `user_id`,
    `credits_micros`, `status`).

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

# Secrets
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put EVAL_ADMIN_TOKEN
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET

# Public variables live in wrangler.toml [vars]:
#   GITHUB_CLIENT_ID, EVAL_FREE_CREDITS, EVAL_PUBLIC_URL,
#   STRIPE_PRICE_P5000..P500000
npm run db:migrate:remote
npm run deploy
```

`wrangler.toml` binds D1 as `DB`, sets `compatibility_flags =
["nodejs_compat"]`, and keeps only non-secret variables in `[vars]`. Bind the
`eval.seanbehan.ca` custom domain in the Cloudflare dashboard (Workers →
your Worker → Settings → Domains & Routes) or by adding a `routes` entry to
`wrangler.toml`. GitHub device flow needs an OAuth app with device flow
enabled; Stripe needs four Prices and one webhook endpoint.

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
| `GITHUB_CLIENT_ID` | for GitHub login | — | Public OAuth app client id; device flow needs no secret. |
| `EVAL_FREE_CREDITS` | no | `250` | One-time grant on first GitHub login. |
| `STRIPE_SECRET_KEY` | for checkout | — | Secret Stripe API key. |
| `STRIPE_WEBHOOK_SECRET` | for webhook | — | Secret `whsec_...` signing secret. |
| `STRIPE_PRICE_P5000` … `STRIPE_PRICE_P500000` | for checkout | — | Public Stripe Price ids for the packs. |
| `EVAL_PUBLIC_URL` | no | `https://eval.seanbehan.ca` | Origin for Checkout success/cancel URLs. |

## Tests and safety

`npm run check` runs `tsc --noEmit` and then `node:test`. Every test injects a
fake `fetch`: OpenRouter, GitHub, and Stripe are mocked, so no test touches a
real API. The D1 store (including the Stripe exactly-once batch) is tested
against in-memory SQLite with the real migration files; those tests skip
gracefully when `node:sqlite` is unavailable.

No secrets or deploys are performed by the test suite. `.dev.vars` is ignored
by git, and only SHA-256 API-key hashes, Stripe event ids, and non-secret
configuration are persisted.

Known scope limits for this Worker: rate limits and daily caps, key revocation
UI, refund/expiry automation, and general-purpose Jev proxying (only built-in
batteries are accepted) are not implemented.
