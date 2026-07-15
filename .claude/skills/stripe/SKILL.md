---
name: stripe
description: >
  Integration patterns for Stripe within Balo — the sole client-charging processor
  (ADR-1041) for the credit system (ADR-1040). Use this skill whenever implementing or
  modifying any client-charging feature: Stripe client wiring, mandate capture
  (Customer + PaymentMethod + off_session SetupIntent), on-session purchase charges,
  off-session charges for overdraft settlement and auto-top-up, the idempotent webhook
  handler, local-currency presentment → AUD credit with fx capture, and ledger
  reconciliation references. Covers idempotency keying, Fastify raw-body handling,
  signature verification, SCA/authentication_required recovery, and env topology.
  Trigger on any mention of Stripe, charge, PaymentIntent, SetupIntent, mandate,
  webhook, off_session, dunning-related charges, credit top-up, or the BAL-382 provider
  layer. Does NOT cover expert payouts (Airwallex, separate ledger).
---

# Stripe Integration Skill

## Balo-Specific Context

Stripe is Balo's **sole processor for charging clients** (ADR-1041). It powers the
prepaid AUD credit wallet (ADR-1040). This module is the **thin, shared provider layer**
(BAL-382) that the credit lanes call — it owns the *mechanism*, never the *business logic
of when to charge*.

It handles:
- **Client wiring** — keys + env topology per ADR-1026 (dev/staging/prod, test-mode below prod)
- **Mandate ops** — create/retrieve Customer, attach PaymentMethod, capture reusable mandate via `off_session` SetupIntent; expose store/reuse of `stripe_customer_id` + `stripe_payment_method_id` + mandate ref on the wallet
- **Charge ops (on-session)** — purchase/top-up charge; local-currency presentment → AUD credit amount + captured `charged_currency / charged_amount_minor / fx_rate`
- **Charge ops (off-session)** — overdraft settlement + auto-top-up against the stored mandate
- **Webhook handler** — single idempotent endpoint: verify signature, key on Stripe event id + state-derived keys, dispatch to the right ledger effect
- **Reconciliation** — every ledger money-entry carries its Stripe reference so entries reconcile to Stripe charges

**Consumers** (own their triggers, NOT this module): BAL-377 purchase/top-up, BAL-378
session consume & overdraft settlement, BAL-379 auto-top-up, BAL-383 promo-continue.

**Out of scope:** expert payouts (Airwallex), invoice/bank-transfer funding (v2 per ADR-1041).

**Stack:** TypeScript, Fastify (backend on Railway), Drizzle ORM, BullMQ + Redis
**SDK:** `stripe` npm package (`pnpm add stripe`) — pin a recent API version explicitly
**Money:** integer AUD minor units (cents) everywhere, matching the append-only ledger

---

## Hard Invariants (do not violate)

1. **This layer never decides *when* to charge.** It exposes primitives; the consumer lanes call them. No wallet-balance logic, no dunning schedule, no top-up thresholds here.
2. **Every money-moving call is idempotent.** BullMQ retries must not double-charge (Stripe idempotency key) or double-apply (state-derived ledger key). See Idempotency below.
3. **Every ledger money-entry carries its Stripe reference** (`payment_intent_id` + `charge_id` + `balance_transaction_id`). Reconciliation depends on it.
4. **Ledger effect + `audit_events` write in the same `db.transaction`** (ADR-1030). Webhook processing is no exception.
5. **Amounts are integer minor units.** Never float. AUD cents in the ledger; presentment minor units captured separately.
6. **Stripe references never leak to client- or expert-facing surfaces** — reconciliation data is admin/internal only (fee-concealment posture holds).

---

## Architecture Summary

```
Mandate capture (on-session, during first purchase — BAL-377)
    → create/retrieve Stripe Customer (metadata.walletId)
    → SetupIntent { customer, usage: 'off_session' } → client_secret to frontend
    → frontend confirms card
    → webhook setup_intent.succeeded → store customer_id + payment_method_id + mandate ref on wallet

On-session purchase / top-up (BAL-377)
    → PaymentIntent in presentment currency, confirmed by frontend
    → webhook payment_intent.succeeded
    → retrieve charge → balance_transaction → capture charged_currency / charged_amount_minor / fx_rate
    → credit AUD to wallet ledger (same txn as audit_events)

Off-session charge (overdraft settlement BAL-378 / auto-top-up BAL-379)
    → PaymentIntent { customer, payment_method, off_session: true, confirm: true }
    → success: webhook payment_intent.succeeded → ledger effect
    → failure code 'authentication_required' → surface to consumer lane (needs on-session SCA)

Any Stripe event
    → POST /webhooks/stripe (raw body)
    → verify signature → insert event_id (ON CONFLICT DO NOTHING) → if seen, ack + return
    → dispatch to ledger effect inside db.transaction (+ audit_events)
    → ack 200
```

---

## SDK Initialisation

```typescript
// apps/api/src/lib/stripe.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-xx-xx', // pin explicitly — do not float with the SDK default
  typescript: true,
  maxNetworkRetries: 2,     // Stripe-side retries are idempotency-safe
});
```

**Environment variables (per ADR-1026 topology — test-mode keys below prod):**
```
STRIPE_SECRET_KEY=            # sk_test_… in dev/staging, sk_live_… in prod
STRIPE_PUBLISHABLE_KEY=       # pk_test_… / pk_live_…
STRIPE_WEBHOOK_SECRET=        # whsec_… — PER ENDPOINT, PER ENV (each endpoint has its own)
```

**Never** hardcode keys. **Never** reuse a prod webhook secret in a preview env — each
endpoint has a distinct signing secret. PR-preview envs point at the test-mode account.

---

## DB Schema (Drizzle) — provider-owned tables

```typescript
// wallet columns added by this layer (expand-contract: additive first)
// on the existing company-scoped wallet (BAL-376)
//   stripeCustomerId: text
//   stripePaymentMethodId: text
//   mandateRef: text            // SetupIntent id / mandate reference
//   mandateStatus: text         // pending | active | requires_action | failed

// Idempotency ledger for webhook events — append-only, event-id keyed
export const stripeWebhookEvents = pgTable('stripe_webhook_events', {
  eventId: text('event_id').primaryKey(),        // Stripe event.id
  type: text('type').notNull(),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
  processedAt: timestamp('processed_at'),         // null until effect applied
  payloadHash: text('payload_hash'),              // optional integrity check
});

// Reconciliation reference carried on every money-moving ledger entry (BAL-376 ledger)
//   stripePaymentIntentId: text
//   stripeChargeId: text
//   stripeBalanceTransactionId: text
//   chargedCurrency: text          // presentment currency, e.g. 'usd'
//   chargedAmountMinor: integer    // presentment minor units
//   fxRate: numeric                // balance_transaction.exchange_rate (null when AUD→AUD)
```

Mandate/customer/PM ids are low-sensitivity references (not card data — Stripe holds the
card), so encryption-at-rest isn't required the way Cronofy tokens are. Still treat them
as PII-adjacent and keep them off client/expert surfaces.

---

## Mandate Capture (on-session)

```typescript
// 1. Customer (idempotent on wallet — retrieve if already stored)
const customer = wallet.stripeCustomerId
  ? await stripe.customers.retrieve(wallet.stripeCustomerId)
  : await stripe.customers.create({ metadata: { walletId: wallet.id } });

// 2. SetupIntent for a REUSABLE off-session mandate
const setupIntent = await stripe.setupIntents.create({
  customer: customer.id,
  usage: 'off_session',                 // critical — enables later off-session charges
  payment_method_types: ['card'],
  metadata: { walletId: wallet.id },
});
// return setupIntent.client_secret to the frontend to confirm the card

// 3. On webhook setup_intent.succeeded:
//    store customer.id + setupIntent.payment_method + setupIntent.id (mandateRef),
//    set mandateStatus = 'active'
```

---

## Charge Ops

### On-session purchase / top-up (presentment currency → AUD credit)

```typescript
const pi = await stripe.paymentIntents.create(
  {
    amount: presentmentAmountMinor,     // minor units in the client's currency
    currency: presentmentCurrency,      // e.g. 'usd'
    customer: wallet.stripeCustomerId!,
    setup_future_usage: 'off_session',  // also lands a reusable mandate on first buy
    metadata: { walletId: wallet.id, purpose: 'topup', ledgerKey },
  },
  { idempotencyKey: ledgerKey },        // stable business key — see Idempotency
);
// frontend confirms → webhook payment_intent.succeeded → capture settlement (below)
```

**Capturing the settlement fields** (fills `charged_currency / charged_amount_minor / fx_rate`):

```typescript
// in the payment_intent.succeeded handler
const charge = await stripe.charges.retrieve(pi.latest_charge as string, {
  expand: ['balance_transaction'],
});
const bt = charge.balance_transaction as Stripe.BalanceTransaction;
// bt.currency === 'aud' (settlement on the AUD account)
// bt.amount    === settled AUD minor units → the credit granted
// bt.exchange_rate → fxRate (null when presentment already AUD)
// charge.currency / charge.amount → chargedCurrency / chargedAmountMinor
```

### Off-session charge (overdraft settlement / auto-top-up)

```typescript
try {
  const pi = await stripe.paymentIntents.create(
    {
      amount, currency,
      customer: wallet.stripeCustomerId!,
      payment_method: wallet.stripePaymentMethodId!,
      off_session: true,
      confirm: true,
      metadata: { walletId: wallet.id, purpose, ledgerKey },
    },
    { idempotencyKey: ledgerKey },
  );
  // success arrives via webhook — do NOT apply the ledger effect from this return value
} catch (err) {
  if (err instanceof Stripe.errors.StripeCardError && err.code === 'authentication_required') {
    // SCA needed — cannot complete off-session.
    // Surface to the consumer lane so it can prompt the client on-session.
    // err.raw.payment_intent has the PI to reuse.
    return { requiresAction: true, paymentIntentId: err.raw.payment_intent?.id };
  }
  throw err; // hard decline / other — let the consumer lane's dunning path handle it
}
```

> **Apply ledger effects from webhooks, not from the create() return.** The return can
> race the webhook; the webhook is the single source of truth and is idempotent.

**SCA recovery sequence (doc-canonical — get this exact).** When an off-session charge
hits an authentication requirement, the request fails **402** and the PaymentIntent lands
in **`requires_payment_method`** (not `requires_action`). You cannot authenticate an
`off_session: true` intent. To recover, the consumer lane must bring the client back
on-session: re-confirm the **same** PaymentIntent with `off_session: false`, which moves
it to `requires_action`, then hand the `client_secret` to the frontend to complete 3DS.
This layer's job is only to detect the condition and surface `{ requiresAction,
paymentIntentId, clientSecret }` — the *when/how to re-prompt* is the consumer lane's
(BAL-378 settlement / BAL-379 auto-top-up). Ref: docs.stripe.com/payments/payment-intents
and the SCA off-session guide.

---

## Webhook Handler (single idempotent endpoint)

### Fastify raw-body gotcha (this bites everyone)

Signature verification needs the **raw request body**. Fastify JSON-parses by default,
which corrupts the signature. Scope a raw parser to the webhook route only:

```typescript
// register raw body for the webhook route
await app.register(import('fastify-raw-body'), {
  field: 'rawBody',
  global: false,
  routes: ['/webhooks/stripe'],
});

app.post('/webhooks/stripe', { config: { rawBody: true } }, async (req, reply) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody!, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return reply.code(400).send({ error: 'invalid signature' });
  }

  // idempotency gate — event-id keyed, append-only
  const inserted = await db
    .insert(stripeWebhookEvents)
    .values({ eventId: event.id, type: event.type })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return reply.code(200).send({ received: true }); // already processed

  await db.transaction(async (tx) => {
    await dispatchLedgerEffect(tx, event);            // + audit_events in the SAME txn (ADR-1030)
    await tx.update(stripeWebhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(stripeWebhookEvents.eventId, event.id));
  });

  return reply.code(200).send({ received: true });
});
```

### Events to handle (v1)

| Event | Effect |
|-------|--------|
| `payment_intent.succeeded` | Credit AUD to wallet; capture settlement fields; write reconciliation refs |
| `payment_intent.payment_failed` | Mark attempt failed; hand to consumer lane's dunning path (no ledger credit) |
| `setup_intent.succeeded` | Store customer/PM/mandate ref; set `mandateStatus = active` |
| `setup_intent.setup_failed` | Set `mandateStatus = failed`; surface to consumer lane |
| `charge.dispute.created` | **Recognise + log** (minimum): flag wallet, write audit event, alert admin. No auto-clawback in v1 |

Keep the switch exhaustive-with-default: unknown event types are ack'd 200 and logged,
never 500'd (Stripe retries on non-2xx and will flood the endpoint).

---

## Fraud (Radar)

Stripe Radar runs on every charge by default — no wiring needed for v1. Two things to
respect at the provider layer:

- **Don't fight `requires_action` from Radar.** A charge Radar flags as elevated risk may
  force 3DS even on-session; that's expected, let the auth flow run.
- **`payment_intent.payment_failed` with a `blocked` outcome is a Radar block, not a bank
  decline** — recognise + log it distinctly (write the `outcome.type` / `outcome.reason`
  to the audit event) so the consumer lane's dunning path doesn't retry a hard block.

Custom Radar rules (block highest-risk, review card-country ≠ IP-country, amount
thresholds) are a **dashboard/config concern, not code** — note them in the admin runbook,
don't hardcode here. Revisit rule tuning post-launch once real charge volume exists.

---

## Idempotency (two independent keys)

Both are required — they protect different failure modes:

1. **Stripe idempotency key** on `create()` — a stable *business* key (e.g.
   `topup:{walletId}:{requestId}` or `settlement:{sessionId}`). BullMQ retries reuse the
   same key, so Stripe returns the original PaymentIntent instead of creating a second charge.
2. **State-derived ledger key** — the webhook's `event.id` gate (above) plus a
   deterministic ledger-entry key, so even a Stripe event *replay* can't double-apply the
   ledger effect. `ON CONFLICT DO NOTHING` on the ledger key is the belt to the event-id
   suspenders.

Never derive the idempotency key from a timestamp or random value — it must be stable
across retries of the *same* logical operation.

---

## Local Development & Testing

- **Webhooks:** use the **Stripe CLI**, not a live MCP.
  `stripe listen --forward-to localhost:3001/webhooks/stripe` (prints the `whsec_` for local),
  `stripe trigger payment_intent.succeeded` (and `setup_intent.succeeded`, `charge.dispute.created`)
  to exercise handlers and replay for idempotency tests.
- **Tests (ADR-1032):** Vitest + Testcontainers Postgres for the ledger effects; assert
  the invariant that a replayed event id applies the effect exactly once. Mock the Stripe
  SDK for unit tests; use `stripe trigger` for integration.
- **Test cards:** `4242…` success; `4000 0025 0000 3155` → SCA/`authentication_required`
  (exercise the off-session recovery path); decline codes per Stripe docs for dunning.
- **CI:** SonarCloud scanner + quality gate both green (two separate checks).

---

## Key Constraints & Gotchas

1. **Pin `apiVersion` explicitly** — never float with the SDK default; a silent bump can change webhook payload shapes.
2. **Raw body for the webhook route only** — global raw parsing breaks the rest of the API.
3. **Ledger effects come from webhooks, not from `create()` returns** — avoid the race; the webhook is idempotent and authoritative.
4. **`off_session: true` charges fail into `requires_payment_method` (402), not `requires_action`** — surface `requiresAction` so the consumer lane can re-confirm the same PI on-session. Don't treat it as a hard decline, and don't try to authenticate the off-session intent directly. (See SCA recovery sequence above.)
5. **Use classic `Customer`, not Accounts v2 / `customer_account`** — current Stripe docs increasingly surface the Accounts v2 preview (`customer_account` param). That's a preview surface Balo hasn't opted into; stick to the `customer` param and the Customers API to match ADR-1041 and avoid preview-only behaviour.
6. **Per-endpoint, per-env webhook secrets** — preview/staging/prod each have their own `whsec_`. Wrong secret = every event 400s.
7. **Amounts in minor units, integers only** — presentment minor units and settled AUD minor units are distinct; store both.
8. **`balance_transaction.exchange_rate` is the fx source of truth** — capture it at settlement, not an app-side rate.
9. **Ack unknown events 200** — non-2xx makes Stripe retry aggressively.
10. **This is a provider layer** — if you find yourself writing "when balance drops below X" logic here, stop and push it back to the consumer lane (escalate the scope fork to Yomi).

---

## Canonical references (official Stripe skill + docs)

**Live authority: the official `stripe-best-practices` skill** (from the Stripe agent
plugin, `stripe@claude-plugins-official`). It auto-updates and is the source of truth for
*current* Stripe API detail — API selection, payments, webhooks, security, and migrating
off deprecated APIs. Consult it (and its `references/*.md`) for field-level specifics
rather than pasting from memory. The doc URLs below are the fallback when the skill isn't
installed:

| Flow | Official page |
|------|---------------|
| SetupIntent `usage: 'off_session'` mandate | docs.stripe.com/payments/setup-intents |
| Save + reuse a payment method | docs.stripe.com/payments/save-and-reuse |
| `setup_future_usage` on first charge | docs.stripe.com/payments/payment-intents |
| Off-session charge + SCA failure/recovery | docs.stripe.com/payments/save-during-payment (+ SCA off-session support article) |
| Webhook signatures (`constructEvent`) | docs.stripe.com/webhooks + docs.stripe.com/webhooks/signatures |
| Idempotent requests | docs.stripe.com/api/idempotent_requests |
| Stripe CLI (listen/trigger) | docs.stripe.com/stripe-cli |

**This skill overrides the official Stripe skill on Balo-specific choices.** The two are
complementary — the Stripe skill is the *generic* current-best-practice layer; this file is
the *Balo* layer (ADR invariants, fee-concealment, audit/ledger, AUD-minor-units,
provider-vs-consumer split). Where they conflict, this file wins. The one that will
actually bite:

- **Accounts v2 / `customer_account`** — the official skill covers Connect Accounts v2 and
  will nudge toward `customer_account`. Balo has **not** opted in: use the classic
  `Customer` API and the `customer` param (see Key Constraints #5, ADR-1041). Do not follow
  the official skill onto that surface.

**What to pin here vs. let the Stripe skill supply:**
- **Pin (in this file):** the flow *skeletons* adapted to the Balo stack, the Balo-specific glue (ledger reconciliation refs, AUD-minor-units, ADR-1030 same-transaction rule), and the non-obvious traps — SCA recovery status, Fastify raw body, two-key idempotency, apiVersion pinning, Customer-not-Accounts-v2. These are where CC-from-memory goes wrong, and they're stable.
- **Let the Stripe skill supply:** exact current field names for the pinned `apiVersion`, precise webhook payload shapes, current test-card matrix, any param renames. These change often enough that a copied snippet rots; the installed skill (or the doc links above) is the source of truth at implement time.

Rule of thumb: this skill encodes *what's specific to Balo and what's easy to get wrong*; the official Stripe skill stays the authority for *what's current* — except where Balo has explicitly chosen otherwise.

---

## Optional: split into reference files (cronofy-style)

If this grows, mirror the cronofy layout — move deep detail into `references/` and keep
this file as the index:

| Task | Reference File |
|------|---------------|
| Mandate capture — SetupIntent + storage | `references/mandate.md` |
| On/off-session charges + fx settlement capture | `references/charges.md` |
| Webhook handler — raw body, signature, dispatch | `references/webhooks.md` |
| Idempotency keys — Stripe + ledger | `references/idempotency.md` |
| Errors — SCA recovery, declines, dispute handling | `references/errors.md` |
