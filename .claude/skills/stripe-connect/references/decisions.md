# Stripe Architecture Decisions

## No Stripe Connect

**Decision:** Balo does not use Stripe Connect (Express, Custom, or Standard).

**Rationale:**
- Balo manually controls when and how experts are paid
- Payout mechanism (Stripe vs Airwallex) is not yet decided
- Connect Express would require experts to have their own Stripe accounts and adds unnecessary compliance overhead
- Admin-initiated payouts give Balo full control over payout timing (e.g. bi-monthly batches)

**Implication:** All client payments flow into Balo's single Stripe account. Expert earnings are an internal ledger only.

---

## Credit Wallet Model

**Decision:** Clients prepay credits, not pay-per-session.

- 1 credit = A$1.00 = 100 Stripe cents
- Credits are purchased via Stripe Checkout (one-time payment)
- Credits are consumed per minute during consultations
- Unused credits expire per ToS (tracked via `expiry` transaction type)

**DB is source of truth.** Never use Stripe metadata to determine a client's balance.

---

## Atomic Balance Updates

**Decision:** Credit balance updates use a `SELECT ... FOR UPDATE` row lock.

```ts
// Always do this inside a transaction
const [profile] = await db
  .select()
  .from(clientProfiles)
  .where(eq(clientProfiles.userId, userId))
  .for('update'); // row-level lock

// Then update
await db
  .update(clientProfiles)
  .set({ creditBalance: profile.creditBalance + creditsToAdd })
  .where(eq(clientProfiles.userId, userId));
```

Never do a read-then-write without the lock — race conditions will cause double-spending.

---

## Webhook-First Architecture

**Decision:** Stripe webhooks drive all balance updates, not API response callbacks.

Rationale: Network failures, browser closes, or redirects can drop the payment completion callback. Webhooks are reliable and retried by Stripe.

Pattern: Checkout session → user redirected to success page (optimistic UI) → webhook arrives → balance updated → Realtime push to client.

---

## Expert Earnings Ledger

**Decision:** Expert earnings are tracked in `expert_earnings` table, not in Stripe.

Each consultation creates an `expert_earnings` row:
- `gross_amount`: what the client paid in credits (converted to AUD cents)
- `platform_fee`: 25% of gross
- `net_amount`: gross - platform_fee
- `status`: pending → approved → paid

Admin reviews and approves earnings before triggering payout (post-MVP).

---

## Expert Bank Details

**Decision:** Collect bank details in-app; do not validate against banking APIs.

Fields: bank name, BSB (6 digits), account number, account name.
Encrypted at rest. Admin manually verifies before first payout.
One record per expert, updated in place.

---

## Payout Execution (Post-MVP, TBD)

The mechanism for paying experts is **not decided**. Options being evaluated:
- **Stripe Payouts API** — straightforward if staying in Stripe ecosystem
- **Airwallex** — better for international payouts, potentially lower FX fees

**Do not implement payout execution until the mechanism is decided.**
