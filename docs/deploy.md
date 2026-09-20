# Deploy `eval.seanbehan.ca`

Everything here is a one-time host-side setup. The code lives in
[`apps/eval-site`](../apps/eval-site) and is a Cloudflare Worker + D1.

## 1. Cloudflare resources

```bash
cd apps/eval-site
npm install
npx wrangler login

# create the D1 database, then copy the printed database_id into wrangler.toml
npx wrangler d1 create eval-guardrails-db

npm run db:migrate:remote
```

Bind the custom domain in **Cloudflare dashboard → Workers → eval-site →
Settings → Domains & Routes → Add → `eval.seanbehan.ca`** (the
`seanbehan.ca` zone must be in the same account), or add a `routes` entry to
`wrangler.toml`.

## 2. Secrets

```bash
npx wrangler secret put OPENROUTER_API_KEY     # pays for Jev
npx wrangler secret put EVAL_ADMIN_TOKEN       # long random bootstrap token
npx wrangler secret put GITHUB_CLIENT_ID       # device-flow OAuth app client id
npx wrangler secret put STRIPE_SECRET_KEY      # sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_... from step 4
```

Non-secret `[vars]` in `wrangler.toml`:

| Variable | Example | Purpose |
| --- | --- | --- |
| `EVAL_PUBLIC_URL` | `https://eval.seanbehan.ca` | Checkout success/cancel URLs |
| `EVAL_FREE_CREDITS` | `250` | One-time GitHub-login grant |
| `OPENROUTER_MODEL` | `~typesafe/jev-latest` | Jev model alias |
| `STRIPE_PRICE_P5000` | `price_...` | 5,000-credit pack |
| `STRIPE_PRICE_P25000` | `price_...` | 25,000-credit pack |
| `STRIPE_PRICE_P100000` | `price_...` | 100,000-credit pack |
| `STRIPE_PRICE_P500000` | `price_...` | 500,000-credit pack |

## 3. GitHub device-flow login

Create a GitHub **OAuth App** under Sean Behan's account:

- Application name: `Sean Behan Eval Guardrails`
- Homepage URL: `https://eval.seanbehan.ca`
- Authorization callback URL: `https://eval.seanbehan.ca` — required by the
  GitHub form but **not used by device flow**. (If a future browser OAuth
  route is added, use `https://eval.seanbehan.ca/auth/github/callback`.)
- **Enable Device Flow: yes**

Copy the **Client ID** into `GITHUB_CLIENT_ID`. No client secret is needed for
the device flow. The CLI requests the `read:user user:email` scope, and the
service defaults to the same scope when the caller omits one. `eval-jev login`
uses `POST /v1/auth/device` and `POST /v1/auth/device/token`; first login
creates the account and returns an `eval_...` key.

For local development, either use the same app (the callback is ignored by
device flow) or create a second OAuth App whose callback is
`http://127.0.0.1:8787`.

## 4. Stripe products

Create four one-time Prices in `docs/pricing.md` amounts (CA$15 / CA$59 /
CA$199 / CA$799) and copy each price id into the matching `STRIPE_PRICE_*`
var.

**Stripe webhook:**

- URL: `https://eval.seanbehan.ca/stripe/webhook`
- Event to listen for: **`checkout.session.completed` only**.
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- The Worker grants credits exactly once from this event. Do not grant from
  `payment_intent.succeeded` or from the browser redirect.

**Checkout success/cancel URLs** are built by the service from
`EVAL_PUBLIC_URL`; they are browser redirects, not webhooks:

- success: `<EVAL_PUBLIC_URL>/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
- cancel: `<EVAL_PUBLIC_URL>/?checkout=cancelled`

For example with `EVAL_PUBLIC_URL=https://eval.seanbehan.ca`, Checkout sends
buyers back to `https://eval.seanbehan.ca/?checkout=success&session_id=...`
after payment. Nothing needs to be configured in the Stripe dashboard for
those URLs.

For local development:

```bash
stripe listen --forward-to http://127.0.0.1:8787/stripe/webhook
```

Use the `whsec_...` printed by the Stripe CLI as `STRIPE_WEBHOOK_SECRET`, and
set `EVAL_PUBLIC_URL=http://127.0.0.1:8787`.

## 5. Deploy

```bash
npx wrangler deploy
```

Check:

```bash
curl -s https://eval.seanbehan.ca/v1/credits \
  -H "Authorization: Bearer $EVAL_API_KEY"
```

## 6. Smoke the product

```bash
npx -y @codebam/eval-jev-guardrails login            # GitHub device flow
npx -y @codebam/eval-jev-guardrails credits
npx -y @codebam/eval-jev-guardrails buy --pack p5000
npx -y @codebam/eval-jev-guardrails install opencode # or hermes / dsh
npx -y @codebam/eval-jev-guardrails doctor opencode
```

## Merchant/legal notes

- Seller of record is **Sean Behan** (own name), not a registered Codebam
  business. Use that name for Stripe products, invoices, receipts, terms and
  refund policy.
- The `eval.seanbehan.ca` subdomain keeps the service under Sean Behan's own
  name.
- `Codebam` stays the GitHub/npm handle only; do not present it as the seller.
- Ontario's own-name operation and the GST/HST registration threshold are
  separate questions; confirm both with an accountant before launch.
