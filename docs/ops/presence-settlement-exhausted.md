# Presence settlement refused: stuck `session.presence_stuck` alerts — ops runbook

**Audience:** Balo admins and on-call engineers. Internal operations document, not customer-facing
help copy (that lives in `docs/help/`).

A presence-sourced credit session (`duration_source = 'presence'`) is settled when its meeting
ends. The durability backstop (pass 6 of `apps/api/src/jobs/credit-session-meter-sweep.ts`) retries
any session whose meeting ended and which never settled. When settlement throws a
`SettlementRefusedError` (`packages/db/src/repositories/credit-sessions.ts:227`), the refusal is
**permanent for those inputs**: the backstop writes an exhaustion marker and stops retrying that
session. The session stays unsettled, so the client keeps a pending receipt and the expert is not
accrued, until someone repairs it.

The `session.presence_stuck` admin alert (BAL-586) is the operator signal for that state. This doc
is how to repair it. There is no admin action that retries or settles a session: the repair is a
code or config fix, then a manual step below.

---

## Why a marked session is never retried

- **A refusal is deterministic.** Every `SettlementRefusedError` site checks the figures or the
  session/meeting pair, with no I/O in between (`credit-sessions.ts:219-224`). Re-running the same
  inputs refuses the same way, so a plain retry would re-mark it forever.
- **The marker removes the session from pass 6.** `findPresenceSettlementCandidates`
  (`credit-sessions.ts`) excludes every session with a
  `credit_session.presence_settlement_exhausted` audit row, so a permanently refused row cannot
  starve newer unsettled sessions out of the oldest-first batch.
- **The alert read does not filter the marker.** `findPresenceUnsettled` still returns marked
  sessions until they settle, which is why the alert keeps its row for as long as the session is
  stuck.

---

## 1. Identify the session

Open the `session.presence_stuck` row in the admin queue.

- The **entity id** is the credit session id (`credit_sessions.id`).
- The **target id** is its meeting id (`meetings.id`); the row's button opens the meeting.
- A marked session has the title "Settlement refused for {company}'s consultation", and its
  evidence names the guard that refused it and points at this doc. The facts list carries a
  "Settlement refused" line with the guard.

An alert without that title is not this runbook's case: it is a session still overrunning its
estimate, or one that has not settled yet and is still being retried every minute.

## 2. Read the marker

The marker is an `audit_events` row: `entity_type = 'credit_session'`, `entity_id` the session id,
`action = 'credit_session.presence_settlement_exhausted'`, `actor_user_id` NULL, and
`metadata { guard, error, meetingId, trigger }` (`credit-sessions.ts:122-128`, written by
`markPresenceSettlementExhausted`).

- `guard` is the `SettlementRefusalGuard` (`credit-sessions.ts:213-218`).
- `error` is the refusal message, with the figure that tripped it.
- The same text is logged at `error` level in dataset `balo-logs`, with `sessionId`, `guard` and
  `error` fields, as
  `Presence settlement permanently refused — marked exhausted and removed from pass 6`
  (`credit-session-meter-sweep.ts:590-611`). If the marker write itself failed, the line is
  `Presence settlement refusal marker write failed — will retry on the next tick`, and the next
  tick retries the marker, so the alert will not show the marked title until it lands.

Count-only check (safe to run against any environment):

```sql
select count(*) from audit_events
where entity_type = 'credit_session'
  and action = 'credit_session.presence_settlement_exhausted'
  and entity_id = '<session id>';
```

To read the marker itself (guard and error), run the same filter as a select and record the output
in the incident ticket:

```sql
select id, created_at, metadata from audit_events
where entity_type = 'credit_session'
  and action = 'credit_session.presence_settlement_exhausted'
  and entity_id = '<session id>'
order by created_at;
```

## 3. Fix by guard

Each guard names a different broken input. **The cause must be fixed first — a code or config fix deployed, or the data repaired**: the
backstop will not run again for this session (see above), and a repair done before the fix lands
re-refuses.

| Guard                  | Refusal sites (`credit-sessions.ts`) | What it means                                                                                                                                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `figure_not_integer`   | `:827`, `:834`                       | A settlement figure (billable, actual, floor, top-up start, draw anchor) was fractional or negative, or the top-up end was fractional. The figures come from `computeMeetingPresenceSettlement` and `buildSettlementRepoFields` in `apps/api/src/services/credit-session/settle-from-presence.ts`.                                                                                                        | Find the caller defect that produced the bad figure, fix and deploy it. The `error` text names the field and value.                                                                                                     |
| `figure_exceeds_bound` | `:840`, `:1822`, `:1828`             | `:840`: the billing floor exceeded `MAX_SESSION_MINUTES`. The floor is `resolveBillingFloorMinutes()` (`apps/api/src/config/billing-floor.ts`), driven by `MEETING_NO_SHOW_FLOOR_MINUTES`. `:1822`/`:1828`: the billed figure exceeded the larger of the session cap and what the meter already drew, or the top-up ran past the billed figure.                                                           | For the floor, correct `MEETING_NO_SHOW_FLOOR_MINUTES` (it is in MINUTES, not seconds) and redeploy the API. For the others, the `error` text gives the figures; fix the settlement arithmetic that produced them.      |
| `meeting_mismatch`     | `:1784`                              | The repository's row-locked read of the session found a different `meeting_id` from the one the service pre-read and computed settlement for. `settleSessionFromPresence` reads `session.meetingId` fresh on every call (`settle-from-presence.ts:354-374`), so this means the session was rebound to another meeting between the service's read and the locked read, or the two rows otherwise diverged. | Investigate what rebound the session to a different meeting. Once the session and meeting agree, a re-run reads fresh inputs and can settle: remove the marker (section 4) so the backstop retries, or settle directly. |
| `open_not_from_zero`   | `:2946`                              | Raised by `openAndSettleFromPresence`, the sessionless path, which opens a session and settles it in one transaction. Pass 6 only settles sessions that already exist, so this guard should not appear on a `session.presence_stuck` row.                                                                                                                                                                 | If it does, treat it as unexpected: capture the `error` text and escalate to engineering before repairing.                                                                                                              |

## 4. Bring the session back to settlement, or settle or cancel it by hand

Use only the paths that already exist. Both are system-only and unauthenticated by design, so they
are run by an engineer from a trusted API process, not from a route.

**Return it to the backstop (after the fix is deployed or the data repaired).** The marker is what removes the session
from pass 6, and `audit_events` is append-only by convention, not by a database guard
(`packages/db/src/schema/audit-events.ts:15-24`). Removing the marker is therefore a deliberate
manual database write:

Run the `select` from section 2 first and record its output. Then delete inside a transaction and
verify exactly one marker row comes back before committing (roll back otherwise):

```sql
begin;
delete from audit_events
where entity_type = 'credit_session'
  and action = 'credit_session.presence_settlement_exhausted'
  and entity_id = '<session id>'
returning id, metadata;
-- verify exactly one row was returned, then:
commit;
-- anything else: rollback;
```

Consequences, so the call is made knowingly:

- It destroys an audit row. Record the session id, the marker's `guard` and `error`, and who
  removed it in the incident ticket first.
- Within one minute the backstop (`runPresenceSettlementPass`) reads the session again and calls
  `settleSessionFromPresence` (`apps/api/src/services/credit-session/settle-from-presence.ts:342`).
  If the fix did not actually resolve the cause, it refuses again and writes a new marker, and the
  alert returns.
- Settlement is idempotent: the repository's row lock is the real guard, so racing the sweep
  cannot double-settle.

**Settle it directly.** An engineer can call `settleSessionFromPresence({ sessionId,
actorUserId: null, trigger })` from a one-off process in `apps/api`. It charges the company's
stored mandate for any overdraft, so use it only after the cause is fixed and only with the same
sign-off as any manual money movement.

**Cancel it.** `creditSessionsRepository.cancel(sessionId)` (`credit-sessions.ts:3149`) releases a
`pending` session and its hold, and nothing else: any other status throws
`InvalidSessionTransitionError`. On a presence session, one still `pending` when its meeting ended
is the client no-show case. Cancelling it waives the no-show floor charge, and `cancel` writes no
audit row. Treat it as a money decision: it needs the same sign-off as a direct settle, and the
cancel must be recorded in the incident ticket. A session that metered credit is not repairable by
cancelling, so it needs a settlement.

## 5. How the alert closes

The row closes itself on the next check, within a minute, once the session has
`billing_finalized_at` set, or is cancelled, or its meeting or session is soft-deleted. Count-only
confirmation:

```sql
select count(*) from credit_sessions
where id = '<session id>' and billing_finalized_at is not null;
```

A count of 1 means the session settled and the alert will resolve without any further action.
