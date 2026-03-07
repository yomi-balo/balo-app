# Stripe Skill — Balo Payment Architecture

## When to use this skill
Read this skill whenever implementing anything involving:
- Client credit purchases (Stripe Checkout)
- Webhook handling (incoming Stripe events)
- Expert earnings ledger (tracking what's owed)
- Expert bank detail collection
- Refunds, disputes, reconciliation

## ⚠️ Critical Architecture Notes

**Balo does NOT use Stripe Connect.**
There are no connected accounts, no Express dashboards, no automatic fund routing to experts.

Balo has ONE Stripe account. All client payments flow into it.
Expert earnings are tracked as an internal ledger in Balo's database.
Payouts to experts are initiated manually by Balo admins via an admin dashboard (post-MVP).
The payout mechanism (Stripe Payouts API vs Airwallex) is **not yet decided** — do not implement it.

## Payment Flow

```
Client buys credits
  → Stripe Checkout session (one-time payment)
  → checkout.session.completed webhook
  → Atomic credit balance update in DB (row lock)
  → credit_transactions record (type: 'purchase')

Client starts consultation
  → Per-minute credit deduction
  → credit_transactions record (type: 'consumption')
  → expert_earnings record (amount owed to expert)

Admin pays expert (post-MVP, manual)
  → Admin dashboard action
  → Payout via Stripe Payouts API or Airwallex (TBD)
  → expert_payouts record
```

## Key Tables

### credit_transactions
Tracks all client credit movements. See `references/schemas/credit-transaction.ts`.
- Types: `purchase | consumption | refund | promo | expiry | adjustment`
- Always insert via atomic update with `.for('update')` row lock on `client_profiles.credit_balance`

### expert_earnings
Tracks accumulated earnings owed to each expert.
- `gross_amount` — what the client paid (in AUD cents)
- `platform_fee` — Balo's 25% cut
- `net_amount` — what the expert earns (gross - fee)
- `status`: `pending | approved | paid`
- Linked to the consultation session

### expert_bank_details
Bank details collected from experts for payout.
- `bank_name`, `bsb`, `account_number` (encrypted at rest), `account_name`
- `verified_at` — set when admin confirms details
- One record per expert; update in place

## Stripe Usage

Balo uses Stripe for:
1. **Checkout Sessions** — client credit purchases
2. **Webhooks** — event-driven balance updates
3. **Refunds** — via `stripe.refunds.create()`
4. Not used for: payouts, connected accounts, transfers

## Idempotency

Every Stripe API call must include an idempotency key.
Every webhook handler must be idempotent (check if already processed).
See `references/examples/idempotency-pattern.ts`.

## Webhook Handling Pattern

1. Verify Stripe signature (`stripe.webhooks.constructEvent`)
2. Return 200 immediately
3. Dispatch to BullMQ with `jobId = event.id` (prevents duplicate processing)
4. Worker handles the actual DB update

Events handled:
- `checkout.session.completed` → credit purchase fulfillment
- `charge.refunded` → credit refund
- `charge.dispute.created` → flag for admin review

See `references/examples/webhook-handler.ts`.

## Credit ↔ AUD Conversion

```ts
// 1 credit = A$1.00 = 100 cents
export const creditsToAUDCents = (credits: number) => credits * 100;
export const audCentsToCredits = (cents: number) => cents / 100;
```

DB is the **source of truth** for credit balance. Never trust Stripe metadata for balance.

## Expert Bank Details

Collect on the Payouts settings tab (BAL-196).
Fields: `bank_name` (text), `bsb` (6 digits, AU), `account_number` (6–10 digits), `account_name` (text).
Store encrypted at rest using the app's encryption utility.
**Do not validate against any banking API** — admin verifies manually.

## What NOT to build (post-MVP / undecided)

- Payout execution (Stripe Payouts or Airwallex — TBD)
- Admin payout dashboard
- Bi-monthly batch payout jobs
- Any Stripe Connect code (Express, Custom, or Standard)
