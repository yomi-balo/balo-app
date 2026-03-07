# Payments Architecture Decisions

## ADR-1010 — Payments & Credit Architecture

**Decision:** Use Stripe Connect Express for expert payouts, with a PostgreSQL credit wallet as the source of truth for all credit balances.

See the full ADR in the Notion Decision Register.

---

## Key Decisions

### Why credit wallet over direct charges?
- Instant balance reads without Stripe API latency
- Supports promotional/referral credits (no Stripe equivalent)
- Atomic DB transactions across billing + other domain events
- Works during Stripe outages (DB is authoritative)

### Why Stripe Connect Express (not Standard)?
- Stripe hosts onboarding — less UI code to build and maintain
- Experts manage their own bank account details via Stripe's dashboard
- Stripe handles KYC for AU (ABN/TFN verification)
- Express accounts get their own Stripe Express Dashboard

### Why BullMQ for webhook processing?
- Webhook endpoint returns 200 immediately — Stripe won't retry
- BullMQ handles retries, backoff, and deduplication (jobId = event.id)
- Async processing keeps the webhook endpoint fast and reliable

### Why nightly reconciliation?
- Webhooks can be missed (network issues, deployment gaps)
- Provides a safety net for credit balance integrity
- Catches any double-processing that slipped through idempotency checks
- Admin is alerted for any discrepancies — never auto-fixed

### Why `FOR UPDATE` row lock on balance changes?
- Without it, concurrent requests can read the same balance and both "win"
- Example: two meetings end simultaneously, both read balance=100, both deduct 50 — result is 50 instead of 0
- Row lock serialises the reads, preventing race conditions

### 25% markup model
- Expert sets their per-minute rate (e.g. $2/min)
- Client-facing rate is displayed with 25% markup (e.g. $2.50/min)
- Balo retains 25% of each consultation revenue
- This is applied at display time — the raw rate is stored in DB
