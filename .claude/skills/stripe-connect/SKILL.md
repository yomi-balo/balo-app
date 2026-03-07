---
name: stripe-connect
description: Balo's Stripe Connect patterns — connected account onboarding, credit wallet architecture, payout flows, webhook handling, and nightly reconciliation. Use when building anything related to expert payments, client credit purchases, per-minute billing, or Stripe webhooks.
---

# Stripe Connect Skill

Balo's payment architecture uses Stripe Connect Express for expert payouts and a **credit wallet** (PostgreSQL) for all client-side billing. Read this entire file before writing any payment-related code.

Related ADR: **ADR-1010** (Payments & Credit Architecture)

---

## When to Use This Skill

- Expert onboarding (Stripe Connect Express account creation + account link)
- Client credit purchases (Stripe Checkout sessions)
- Expert payout requests (transfers to connected accounts)
- Webhook handling for any Stripe event
- Credit balance queries and transaction history
- Nightly reconciliation jobs

---

## Critical Design Principles

| Principle | Detail |
|-----------|--------|
| **DB is source of truth** | Credit balance lives in `users.credit_balance`, NOT Stripe |
| **Webhooks update local state** | Stripe is the audit log; DB is authoritative |
| **All transactions via credit wallet** | No direct charges — always go through the wallet |
| **Idempotency on every API call** | Every `stripe.*` call uses an idempotency key |
| **Webhooks → BullMQ → process** | Return 200 immediately; process async |
| **Row lock on balance updates** | Use `FOR UPDATE` to prevent race conditions |

---

## Connected Accounts (Expert Onboarding)

**Account type: Stripe Connect Express** — Stripe hosts the onboarding dashboard, experts manage their own bank details, Stripe handles KYC. Australia-specific: requires ABN or TFN + AU bank account.

See: `references/examples/connected-account-onboarding.ts`

**Onboarding flow:**
1. Expert clicks "Set up payments" in settings
2. Server action creates Express account → stores `stripe_connect_id` in `expert_profiles`
3. Generate account link → redirect expert to Stripe-hosted form
4. Expert completes bank details on Stripe
5. Stripe redirects back to `/expert/settings?tab=payouts&setup=complete`
6. Server checks `account.payouts_enabled` + `account.charges_enabled` to confirm
7. Webhook `account.updated` keeps status in sync going forward

**Return URL pattern:**
```
refresh_url: https://balo.expert/expert/settings?tab=payouts&refresh=true
return_url:  https://balo.expert/expert/settings?tab=payouts&setup=complete
```

---

## Credit Wallet Architecture

**Why DB is source of truth (not Stripe):**
- Instant reads — no Stripe API latency on balance checks
- Offline resilience — works during Stripe outages
- Supports promotional credits (no Stripe equivalent)
- Atomic operations with other DB writes (e.g., deduct credits + create case message in one tx)
- Enables credit gifting, referral credits, admin adjustments

### Credit Transaction Types

```typescript
export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'purchase',    // Client buys credits via Stripe Checkout
  'consumption', // Credits used during consultation (per-minute billing)
  'refund',      // Credits returned to client (dispute, cancellation)
  'promo',       // Promotional credits (referral bonus, coupon, admin gift)
  'expiry',      // Credits expired (if expiry policy enabled)
  'adjustment',  // Manual admin adjustment (support case resolution)
]);
```

See full schema: `references/schemas/credit-transaction.ts`

### Balance Update Pattern

Always use `addCredits()` — never update `credit_balance` directly.

```typescript
// Correct pattern — atomic with row lock
await addCredits(userId, amount, 'purchase', { stripePaymentIntentId, idempotencyKey });

// NEVER do this
await db.update(users).set({ creditBalance: newBalance }).where(eq(users.id, userId));
```

See: `references/examples/credit-purchase-flow.ts` for the full atomic transaction pattern.

---

## Payment Flows

### 1. Credit Purchase (Client → Stripe Checkout → Credits Added)
See: `references/examples/credit-purchase-flow.ts`

Key points:
- Use Stripe Checkout Session in `payment` mode
- Store `userId`, `packageId`, `credits`, `idempotencyKey` in session metadata
- Credits added in `checkout.session.completed` webhook handler (via BullMQ)
- Currency: `aud`

### 2. Consultation Charge (Per-Minute Billing)
See: `references/examples/expert-payout-flow.ts` (chargeForConsultation section)

Key points:
- Triggered by meeting-end webhook (Daily.co or Recall.ai)
- BullMQ job calculates billable minutes
- Single DB transaction: deduct from client + add to expert pending balance
- Expert credits released after hold period

### 3. Expert Payout (Credits → AUD Transfer)
See: `references/examples/expert-payout-flow.ts`

Key points:
- Verify: `stripeAccountId` exists, `charges_enabled`, minimum threshold, sufficient balance
- Use `stripe.transfers.create()` with idempotency key
- Deduct from expert wallet atomically with transfer creation
- `transfer.paid` webhook confirms completion; `transfer.failed` reverses it
- Conversion: use `creditsToAUDCents()` — never hardcode amounts

---

## Webhook Handling

**Endpoint:** `POST /webhooks/stripe` on the Fastify API (Railway)

**Pattern: verify → queue → return 200**

```typescript
// 1. Verify signature (reject immediately if invalid)
event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);

// 2. Dispatch to BullMQ (jobId = event.id deduplicates)
await stripeEventQueue.add(event.type, payload, { jobId: event.id });

// 3. Return 200 immediately — don't process inline
return reply.status(200).send({ received: true });
```

See: `references/examples/webhook-handler.ts`

### Events Handled

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Add credits to client wallet |
| `transfer.paid` | Mark payout as completed |
| `transfer.failed` | Reverse payout, re-add credits to expert wallet, notify |
| `account.updated` | Update expert's Stripe account status in DB |
| `charge.refunded` | Deduct credits from client wallet |
| `charge.dispute.created` | Flag case, freeze expert payout, notify admin |

### Idempotency Pattern

Every handler checks `idempotencyKey` before processing:

```typescript
const idempotencyKey = `checkout_${data.id}`;
const existing = await creditTransactionRepo.findByIdempotencyKey(idempotencyKey);
if (existing) return; // Already processed — skip silently
```

See: `references/examples/idempotency-pattern.ts`

---

## Nightly Reconciliation

Scheduled BullMQ job that catches missed webhooks and flags balance discrepancies.

See: `references/examples/reconciliation-job.ts`

Key points:
- Fetches Stripe charges from last 24h, cross-checks against `credit_transactions`
- Logs `warn` for missing transactions (can auto-fix purchases)
- Logs `error` for balance discrepancies — **alert admin, never auto-fix balances**

---

## Environment Variables

```bash
# Frontend (apps/web) — client-safe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...   # or pk_live_...

# API server (apps/api on Railway) — server-only
STRIPE_SECRET_KEY=sk_test_...                     # NEVER in NEXT_PUBLIC_
STRIPE_WEBHOOK_SECRET=whsec_...                   # From Stripe webhook dashboard
STRIPE_PUBLISHABLE_KEY=pk_test_...                # Also on API for checkout sessions
```

---

## Local Testing

```bash
# Forward webhooks to local API
stripe listen --forward-to localhost:3001/webhooks/stripe

# Trigger specific events
stripe trigger checkout.session.completed
stripe trigger account.updated
stripe trigger transfer.paid

# Test card numbers
4242424242424242   # Visa — succeeds
4000000000000002   # Visa — declined
4000000000009995   # Visa — insufficient funds
```

---

## Anti-Patterns — Never Do These

| ❌ Don't | ✅ Do instead |
|----------|--------------|
| Trust Stripe as source of truth for balance | Always read `users.credit_balance` from DB |
| Skip idempotency keys | Every `stripe.*` call uses an idempotency key |
| Process webhooks synchronously | Dispatch to BullMQ, return 200 immediately |
| Store `STRIPE_SECRET_KEY` in `NEXT_PUBLIC_` | Keep it server-only on Railway |
| Allow negative credit balances | Check balance before deducting; throw if insufficient |
| Skip the row lock | Always use `.for('update')` when modifying balances |
| Forget `transfer.failed` handling | Must reverse payout + re-add credits + notify |
| Hardcode AUD amounts | Use `creditsToAUDCents()` conversion function |
| Update `credit_balance` directly | Always go through `addCredits()` |
