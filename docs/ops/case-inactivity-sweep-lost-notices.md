# Case-inactivity sweep: lost close notices — ops runbook

**Audience:** Balo admins and on-call engineers. Internal operations document, not customer-facing
help copy (that lives in `docs/help/`).

The case-inactivity sweep (BAL-572, `apps/api/src/jobs/case-inactivity-sweep.ts`) runs hourly at
`:30`. It closes each case that has gone 30 days with no consultation, booking, reschedule,
cancellation, message or file, and has nothing booked ahead, as `auto_inactive`. Once the close
has committed, it publishes `engagement.case_closed`, so the expert delivering the case (and the
client company's owner, when the company has one) is told.

**If that post-commit notice fails, the case stays closed and the notice is never retried.** This
doc is how to find those cases. There is no monitor yet; run the queries below by hand.

---

## Why a lost notice is never retried

- **The close is already committed.** The notice runs after `caseEngagementsRepository.close()`
  commits, and a notice failure never undoes the close. The next tick reads only OPEN cases
  (`listOpenCreatedBefore`), so it never sees the case again.
- **A naive re-publish can be swallowed.** The payload's `correlationId` is always
  `{engagementId}:case_closed`, and each delivery's BullMQ job id is built from it
  (`buildJobId(template, recipientId, correlationId)`). A second publish for the same case can be
  deduplicated against a job BullMQ still retains, and then nothing is sent.
- **The durable fix is an outbox** (see [Follow-up](#follow-up-the-outbox)), not a retry loop.

A failed notice is different from a failed close. `failed` in the tick summary means the re-check
or `close()` itself threw: that case is still open, and the next tick tries it again.
`noticeFailed` means the case closed and nobody was told.

---

## The two log lines

Dataset `balo-logs`, logger context `case-inactivity-sweep`. Both are matched by **exact string
equality** below, and both are pinned word for word in
`apps/api/src/jobs/case-inactivity-sweep.test.ts`. Rewording either is a three-place change, made
together: the code, the literal in the test, and this doc.

### Per case: the notice failed

```
msg == "Case inactivity sweep: post-commit notice failed"
```

`level` `error`. Fields: `engagementId` (the case), `error`, `stack`. One line per case whose
notice threw, whether one of the reads that build it or the publish itself failed.

### Per tick: the summary

```
msg == "Case inactivity sweep complete"
```

`level` `info`, once per tick. Fields: every counter in `CaseInactivitySweepResult`, including
`closed` and `noticeFailed`. `noticeFailed` is a subset of `closed`: the close counted, the notice
did not go out.

---

## Axiom queries

### Q1: ticks that lost a notice

```kusto
['balo-logs']
| where ['context'] == "case-inactivity-sweep" and msg == "Case inactivity sweep complete"
| extend nf = toint(column_ifexists("noticeFailed", 0))
| where nf > 0
| project _time, hostname, noticeFailed = nf, closed = toint(column_ifexists("closed", 0))
```

`column_ifexists` is deliberate, not a workaround: until the first tick ships, `noticeFailed` and
`closed` have never been ingested, and a bare field reference fails with `invalid field` (see
`docs/ops/settlement-consent-instrument-pin-monitors.md`, "The `column_ifexists` requirement").

### Q2: which cases, and why

```kusto
['balo-logs']
| where ['context'] == "case-inactivity-sweep" and level == "error"
| where msg == "Case inactivity sweep: post-commit notice failed"
| project _time, engagementId = tostring(column_ifexists("engagementId", "")), error = tostring(column_ifexists("error", "")), stack = tostring(column_ifexists("stack", ""))
```

Drop the `msg` line to see every per-case error from the sweep. The other two are
`Case inactivity sweep: re-check failed` and `Case inactivity sweep: close failed`, and neither is
a lost notice: those cases are still open and are retried on the next tick.

---

## After log retention: count-only SQL

Once the window you care about has aged out of Axiom, the logs are gone. The database still
records what happened: every successful notice leaves an in-app row for the expert. The expert rule
(`engagement-case-closed-expert`, in `apps/api/src/notifications/engine/rules.ts`) fires on every
`auto_inactive` close. The client rule skips a company with no live owner, so only the expert's row
is a reliable marker.

```sql
-- Auto-closed cases whose expert never received the in-app close notice. Count only.
SELECT count(*) AS lost_close_notices
FROM case_engagements ce
WHERE ce.close_reason = 'auto_inactive'
  AND ce.closed_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM user_notifications un
    WHERE un.metadata->>'correlationId' = ce.engagement_id::text || ':case_closed'
      AND un.metadata->>'template' = 'engagement-case-closed-expert'
  );
```

- **15 minutes** leaves room for the notification engine's queue, so a notice still in flight is
  not counted as lost.
- **`user_notifications.deleted_at` is not filtered on purpose.** A notification the expert has
  since dismissed was still delivered.
- **This count is a superset of the logs.** It also catches two losses that no sweep log line
  records: a process crash between `close()`'s commit and the publish (no log line, no counter),
  and a publish that succeeded but whose in-app delivery then failed inside the notification
  engine (logged under the engine's own context, not the sweep's).
- Run it in the Supabase SQL editor for the production project. It returns a count and no
  personal data. For per-case
  detail inside the retention window, use Q2.

There is no tool to re-send a lost notice. The case itself is closed correctly; the only gap is
that the parties were not told. If it matters for a given case, support can tell them directly.

---

## Follow-up: the outbox

**Not done by BAL-572.** The durable fix is to write the notice as a `scheduled_notifications` row
inside `close()`'s transaction, so it commits or rolls back with the close. The dispatch tick
(`apps/api/src/jobs/scheduled-notification-dispatch.ts`) then publishes it, and Postgres, not the
sweep's single in-process publish, holds the promise that a notice is owed. That closes the
crash window too. Until it ships, the queries above are the only way to see a lost notice.
