# Eval Guardrails pricing

This is the cost-plus model behind `eval.seanbehan.ca`. Prices are set so that
even the worst-case provider and hosting cost per check is covered with margin
at every pack size.

## Credit definition

- **1 credit = 1 evaluation** = one Jev call answered by the service.
- A service-side cache hit costs **0.1 credit**.
- `guard_credits` / `GET /v1/credits` is free.
- Provider or transport failures refund the reservation; users never pay for a
  failed provider call.
- Every plan starts with **250 free credits** after GitHub login, with rate
  limits.

## Worst-case cost per evaluation

| Component | Worst case |
| --- | --- |
| Jev input | OpenRouter Jev is $0.042/M input tokens, $0 output. The service caps state at 12,000 characters and accepts only the built-in batteries, so worst case is ~6k input tokens including retry headroom. |
| Provider cost | ~US$0.00025 per eval |
| FX + payment/hosting buffer | rounded to **CA$0.0007 per eval** |
| Stripe Canada | 2.9% + CA$0.30 per successful charge |
| Cloudflare Workers + D1 | CA$5/month paid plan plus negligible per-request/D1 cost, covered by pack margin |

Actual usage is far smaller: most evaluations send a few hundred tokens, so
the effective cost is roughly US$0.00001–0.00005. The prices below are floor
prices that still work if every user is a worst-case sender.

## Packs

| Pack | Price | Per credit | Worst-case service cost | Stripe net | Worst-case margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Free trial | CA$0 | — | capped at 250 credits | — | — |
| 5,000 credits | CA$15 | CA$0.0030 | CA$3.50 | CA$14.27 | 75% |
| 25,000 credits | CA$59 | CA$0.00236 | CA$17.50 | CA$56.99 | 69% |
| 100,000 credits | CA$199 | CA$0.00199 | CA$70.00 | CA$192.93 | 64% |
| 500,000 credits | CA$799 | CA$0.00160 | CA$350.00 | CA$775.53 | 55% |

A typical agent turn that uses prompt + tool-call + tool-result screens costs
about 3 credits (≈ CA$0.006–0.009 at list). A build-and-test loop that makes
30 guarded tool calls costs 30 credits (≈ CA$0.06–0.09).

## Why credits are prepaid

Prepaid credits make the financial worst case bounded: a user cannot spend more
provider budget than the credits they purchased. The service also enforces:

- API-key rate limits;
- a maximum state size per evaluation;
- built-in batteries only (the service is a guardrail, not a general-purpose
  Jev proxy);
- account/key daily caps;
- a global kill switch for provider incidents.

## Refunds and expiry

- Unused, unspent credits are refundable within 14 days of purchase.
- Provider failures are automatically refunded to the credit balance.
- Credits do not expire while the service is offered; if the service is
  discontinued, remaining credits are refunded on request.
- Abuse (bypassing rate limits, reselling API keys, using the service as a
  generic LLM) may terminate access with a pro-rata refund of unused credits.

## Merchant identity

The seller is **Sean Behan**, operating under his own name. Stripe products,
invoices, receipts, and the checkout page must show `Sean Behan`, not
`Codebam`. `Codebam` remains the GitHub/npm handle only.
