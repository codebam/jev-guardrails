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

- Homepage: `https://eval.seanbehan.ca`
- Authorization callback URL: `https://eval.seanbehan.ca` (unused by device
  flow, but required by GitHub)
- **Enable Device Flow: yes**

Copy the **Client ID** into `GITHUB_CLIENT_ID`. No client secret is needed for
the device flow. `eval-jev login` uses `POST /v1/auth/device` and
`POST /v1/auth/device/token`; first login creates the account and returns an
`eval_...` key.

## 4. Stripe products

Create four one-time Prices in `docs/pricing.md` amounts (CA$15 / CA$59 /
CA$199 / CA$799) and copy each price id into the matching `STRIPE_PRICE_*`
var. Add a webhook endpoint:

- URL: `https://eval.seanbehan.ca/stripe/webhook`
- Event: `checkout.session.completed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

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
