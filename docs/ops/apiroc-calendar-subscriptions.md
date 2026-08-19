# Apiroc calendar subscriptions — ops runbook

**Audience:** Balo admins and on-call engineers. This is an internal operations document, not
customer-facing help copy (that lives in `docs/help/`).

Covers the async freshness path for expert calendars: the per-calendar Apiroc `event`
subscriptions, the Svix webhook that receives change pushes, the sweep that creates and renews
them, and the daily monitor that pages when any of it falls behind. Shipped in BAL-468.

For the vendor's runtime behaviour and the evidence behind every claim here, see
`.claude/skills/apiroc/SKILL.md` and `.claude/skills/apiroc/references/webhooks-and-events.md`.

---

## What this feature is

Balo learns that an expert's external calendar changed in two ways:

1. **Polling** — a 15-minute staleness cron plus a health probe that re-checks each connection
   at most hourly. This has always existed and still runs.
2. **Push** — Apiroc POSTs a Svix-signed webhook when a subscribed calendar changes, and Balo
   enqueues a whole-window availability rebuild. This is what BAL-468 added.

The push path is an **optimisation on top of polling, not a replacement for it.** Do not remove
or relax the 15-minute cron without closing the lost-update window described below — the cron is
its only backstop.

A change webhook is a **bare trigger**. It carries no event id and no calendar contents, and
Balo reads none: availability is always recomputed from free/busy (busy blocks, no titles).

---

## Turning it on

There is **no feature flag.** The merge commit is a behavioural no-op and the feature turns on
when both environment variables below are set on the Railway **API** service. Config-as-gate is
deliberate: each variable is independently required, so the incoherent states a flag would allow
(on with no base URL, on with no cipher key) cannot be expressed.

| Variable                  | Value                                                                                                                     | Absent ⇒                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CALENDAR_ENCRYPTION_KEY` | 32+ random bytes, base64. **Mint a new secret** — never reuse `PAYOUT_ENCRYPTION_KEY`; that is a separate trust boundary. | Reconciliation skips; the webhook answers `503`.                                |
| `APIROC_WEBHOOK_BASE_URL` | `https://api.balo.expert` — **must** be `https`, the vendor rejects anything else for a `webhookUrl`.                     | Reconciliation skips; the monitor runs but reads nothing and alerts on nothing. |

### Rollout

1. **Merge.** Confirm nothing changed: `apiroc_webhook_not_configured` appears, no
   `apiroc_subscription_expiry_alert`, `calendar_subscriptions` stays empty.
2. Mint and set `CALENDAR_ENCRYPTION_KEY`.
3. Set `APIROC_WEBHOOK_BASE_URL`.
4. **Redeploy** — the variables take effect at process start.
5. **Within one probe interval (≤1h)**, confirm `apiroc_subscription_reconcile_completed` shows
   a non-zero `created`, the row count is roughly the sum of conflict-checked calendars over
   ACTIVE connections, and **every row has a non-null `expiration` and `expiration_synced_at`.**
   If expirations are null, the verification pass is failing — investigate before continuing.
6. **Confirm inbound push:** ask one connected expert to change an event, then look for
   `apiroc_webhook_processed` and a new `apiroc_webhook_events` row. Triage by status using the
   table below.
7. **After 7+ days**, confirm renewal ran: expirations rolled forward, superseded rows
   soft-deleted, and neither `apiroc_subscription_expiry_alert` nor
   `apiroc_subscription_delete_unverified` ever fired. ⚠ **This is also the observation that
   answers whether Apiroc auto-renews** — if it does, expirations move with no renewal planned.
   Record the answer on BAL-455 either way.

### Revert

Unset `APIROC_WEBHOOK_BASE_URL` and redeploy. All reconciliation stops immediately, and the
monitor goes fully quiet (all three arms are gated on the feature being configured, precisely so
that a revert does not page daily about rows nothing is allowed to repair).

Existing subscriptions keep delivering until their 7-day expiry. Each delivery is still verified
and still turns into an idempotent, coalesced rebuild, so the revert is safe and quiet.

To revert **hard**, additionally soft-delete every `calendar_subscriptions` row. The webhook then
answers `404`, Svix retries and disables each endpoint after ~5 days, and the vendor-side records
lapse naturally.

---

## ⚠ Key rotation is destructive

Rotating `CALENDAR_ENCRYPTION_KEY` makes **every stored `endpoint_secret` undecryptable.** Every
inbound delivery answers `503` and no subscription can be verified again. There is no dual-key
read path today.

Recovery, which is cheap and self-healing:

1. Set the new key.
2. Soft-delete every `calendar_subscriptions` row (one statement).
3. The next reconcile pass re-creates them — new rows, new URLs, new secrets. The previous
   vendor-side subscriptions become orphans (URL prefix matches, row id no longer live) and the
   same pass deletes them.

Cost is one round of churn. Rotation frequency is expected to be ~never; if that changes, add a
`CALENDAR_ENCRYPTION_KEY_PREVIOUS` read path first.

---

## Webhook status triage

The route is the only unauthenticated write path in the calendar surface. It is authenticated by
Svix HMAC over the raw bytes under a **per-subscription** secret, so a compromised secret is
contained to one calendar's trigger.

Design rule: **any non-2xx is retried.** Never answer `200` to a body that was not processed, and
never answer `4xx` to a condition a retry would fix.

| Status seen                                     | Means                                                                                                                                                 | Action                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`                                           | Verified and enqueued, or an idempotent replay, or an unknown `eventType` that is permanently unactionable                                            | None                                                                                                                                                         |
| `400 invalid signature`                         | Bad signature, stale timestamp, or missing raw body. The wire body never names which — check the `reason` field on `apiroc_webhook_signature_invalid` | If sustained, someone is probing. If it started suddenly for real deliveries, suspect a secret mismatch — soft-delete the row and let the sweep re-create it |
| `400 invalid_payload`                           | Verified origin, but the body is not JSON or fails the schema                                                                                         | The vendor changed its body shape. Do not retry-loop it; fix the boundary                                                                                    |
| `404 not_found`                                 | The URL names no live subscription row                                                                                                                | Normal for a stale vendor subscription after teardown — it lapses within 7 days. If it is a _current_ expert, the row/URL mapping is wrong                   |
| `404` + `apiroc_webhook_connection_missing`     | A live subscription row points at a connection that is soft-deleted or gone                                                                           | A partially-failed disconnect. Soft-delete the orphaned subscription rows for that connection                                                                |
| `503 webhook_not_configured`                    | `CALENDAR_ENCRYPTION_KEY` unset, or the stored secret will not decrypt                                                                                | Configuration/outage on our side. Deliveries stay in the vendor's retry queue — fix the variable                                                             |
| `503 enqueue_failed` / `rate_limit_unavailable` | Redis is down. The rate limiter **fails closed** deliberately                                                                                         | Restore Redis; the marker stays unprocessed so retries repair it                                                                                             |
| `500`                                           | A genuine bug — every reachable condition above is classified deliberately                                                                            | Escalate                                                                                                                                                     |

---

## The daily monitor

Runs at **07:00 UTC**, offset from the other sweeps (dormancy 03:00, fx 05:00, dunning 09:00).
It alerts on **count > 0 in any arm, never on a threshold** — if renewal is working, the steady
state is zero.

| Arm            | Question                                                                                                    | What a hit means                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `expiring`     | Rows expiring inside 48h                                                                                    | Renewal is in arrears                                                                          |
| `unconfirmed`  | Created >2h ago and **never stamped** by the vendor — `expiration` **and** `expiration_synced_at` both null | Nobody has looked — the reconciler's `list` pass is not succeeding for this row                |
| `unsubscribed` | A live ACTIVE connection that **wants** ≥1 subscription (has ≥1 conflict-checked calendar) and has none     | The shape a silent platform-wide expiry leaves behind — no per-subscription check can see this |

Two things the arms deliberately do **not** flag. Both are legitimate steady states, and
alerting on either would page every day with the self-heal structurally unable to fix it:

- **A subscription the vendor confirmed as having no expiry.** `expiration` null with
  `expiration_synced_at` set is a real answer, not ignorance. Only both-null is "unconfirmed".
- **An ACTIVE connection with no conflict-checked calendar.** It correctly wants zero
  subscriptions. This is reachable, not theoretical: if the provider reports no writable
  calendar as primary, the connection is still persisted ACTIVE with every `conflictCheck`
  false.

The monitor also **self-heals**: it enqueues a reconcile for every affected connection. That does
**not** suppress the alert — "renewal was late" is worth knowing even after a successful repair.

⚠ **The paging signal is the `apiroc_subscription_expiry_alert` log line** (Axiom + Sentry), not
the in-app notification. The notification is an ops courtesy to `admin_users`; it ships with no
`actionUrl` because there is no admin page for calendar subscriptions yet.

### Why the thresholds are what they are

`probe interval (1h)  ≪  alert at 48h  <  renew at 72h  ≪  vendor TTL (7d)`

The 24-hour gap between renewing and alerting is load-bearing. If they were equal, the monitor
would alert every day on rows the renewer was about to fix and the alert would carry no
information. With the gap, a row reaching the alert threshold means renewal has been failing for
a full day — which is exactly when a human should look. Both orderings are asserted at module
load, so inverting them fails loudly rather than silently.

---

## Things that will surprise you

- **A ping means "something changed, recompute" and nothing more.** There is no event id, and
  deliveries **coalesce** — 8 calendar changes were observed producing 5 deliveries in ~10s
  windows. One ping ≠ one change, in either direction.
- **`calendar.event.changed` is the only event type ever observed.** Unknown types are logged
  and acked; never treat the set as closed.
- **Revocation fires no webhook.** `credential.updated` was observed _not_ firing across a
  revoke and the resulting `ACTIVE → EXPIRED` flip. The health probe remains the only breakage
  signal — the webhook path cannot replace it.
- **Subscriptions are per calendar.** The account-wide `subscriptionType: 'calendar'` returns
  **HTTP 500** on the live API (vendor bug, BAL-455) and is never sent. An expert with three
  conflict-checked calendars holds three subscriptions, each with its own 7-day clock.
- **Two live rows for one calendar is normal, not corruption.** Renewal is create-then-delete, so
  both rows are live during the overlap. Uniqueness is on the vendor's `webhook_subscription_id`;
  canonicity is derived as "newest live row wins".
- **Reconnect ordering is reconnect → delete → re-create.** Deleting a subscription is forbidden
  (403) while the credential is EXPIRED, so the obvious delete-then-recreate order cannot run.
- **Deleting uses the vendor's `id`, not its field named `subscriptionId`.** The latter is the
  provider's channel reference; passing it is a silent no-op that leaves a live subscription
  delivering for 7 days.
- **A known accepted gap: the lost-update window.** BullMQ's `jobId` coalesces a duplicate only
  while the job is _waiting_; once a rebuild is running, the id is freed, so a webhook arriving
  mid-rebuild is dropped. The 15-minute staleness cron is the backstop. This is why that cron
  must not be relaxed until the window is closed.
