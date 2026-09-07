# Settlement consent + instrument-pin Axiom monitors — ops runbook

**Audience:** Balo admins and on-call engineers. Internal operations document, not customer-facing
help copy (that lives in `docs/help/`).

Covers the two Axiom monitors and the dashboard tile shipped for **BAL-545**, a residual of
[BAL-525](https://linear.app/balo-tech/issue/BAL-525) (PR #279, `apps/api/src/services/credit-session/end-session.ts`).
BAL-525 added two log lines on the settlement money path that were **inert until something
watched them** — a detection surface with no detector is not a control. BAL-545 is that detector.

**No application code shipped with this ticket.** The log lines already existed and their field
names are stable by design; this doc records the Axiom-side configuration built on top of them.

---

## What was actually built

Before this ticket, this Axiom org (`balo-6ibo`) had **zero monitors, zero notifiers, and zero
dashboards of its own** — only the vendor-installed demo dashboards. These are the first ones.
There was no existing "money-path alert" destination to route into (the ticket's premise that one
already existed did not hold — see the amendment note at the bottom).

| What               | Name                                                                                   | Kind      | Link                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| Notifier           | `BAL-545 money-path alerts (email)`                                                    | Email     | Axiom → Monitors → Notifiers                                                         |
| Monitor (signal 1) | `BAL-545: Settlement instrument pin disagreement`                                      | Match     | `https://app.axiom.co/balo-6ibo/monitors/view/iqVhZL1NXF0Oi9Duy0`                    |
| Monitor (signal 2) | `BAL-545: Settlement consent race rate (mandate active at commit, gone by settlement)` | Threshold | `https://app.axiom.co/balo-6ibo/monitors/view/reELyiGGQKbPMtD7fJ`                    |
| Dashboard          | `Credit Settlement Monitors`                                                           | —         | `https://app.axiom.co/balo-6ibo/dashboards/uid/1cbd93fc-4b21-4235-89f7-fc2ef15dd8da` |

The notifier is a single shared Email notifier to the on-call engineer's address, reused by both
monitors. **Follow-up (see below): wire a real team destination** (Slack/PagerDuty) once one
exists — email was the only zero-setup option available at build time.

---

## The two signals

Both emitted from `settleOverdraft` (`apps/api/src/services/credit-session/end-session.ts`),
dataset `balo-logs`. Both `msg` strings were confirmed **verbatim against `main` at build time**
— if a later refactor rewords either, fix the monitor's query **and** add the string to the
invariant suite's counted assertions (`apps/api/src/invariants/`) so it cannot drift silently
again (there is no such pinning test today; this is the first time either string has needed one).

### Signal 1 — instrument-pin disagreement (Match monitor, alerts on any occurrence)

```
msg == "Settlement instrument pin disagrees with the wallet — charging the live instrument (BAL-525: the pin is evidence and preference, never authority)"
```

Fields: `sessionId`, `walletId`, `pinnedCustomerId`, `pinnedPaymentMethodId`, `livePaymentMethodId`,
`pinnedAt`, `mandateActiveAtCommit`.

This should be rare to the point of never on the production path today — BAL-516's
`hasActiveSessionForWallet` guard refuses a settings-page card change for the entire live window,
and a detach nulls the mandate (so the branch above it fires instead). Any occurrence is the first
evidence anyone has had that an instrument moved under a live session, so this pages on
**count > 0**, not a rate.

**Monitor query:**

```kusto
['balo-logs']
| where msg == "Settlement instrument pin disagrees with the wallet — charging the live instrument (BAL-525: the pin is evidence and preference, never authority)"
```

Type: **Match** (fires on any matching event). Checks every 1 minute (Axiom's Match-monitor
default). Notifier: the shared email notifier above.

### Signal 2 — consent absent at settlement time (Threshold monitor, alerts on a rate)

The no-usable-mandate branch — `msg == "Overdraft with no usable mandate AT SETTLEMENT TIME —
opening receivable + dunning"` — fires on **every** settlement with no usable mandate, regardless
of history. The race BAL-525 closed is the **subset** where `mandateActiveAtCommit == true`:
consent was live when the debt was computed and gone by the time settlement ran.

Volume of the no-usable-mandate branch overall is expected to be non-zero (a client can
legitimately revoke or detach mid-session, or never have had a mandate at all), so this wants a
**rate**, not `count > 0` — otherwise it pages on normal traffic.

**Monitor query:**

```kusto
['balo-logs']
| where msg == "Overdraft with no usable mandate AT SETTLEMENT TIME — opening receivable + dunning"
| summarize total = count(), race = countif(column_ifexists("mandateActiveAtCommit", false) == true)
| where total >= 5
| extend racePct = round(100.0 * race / total, 1)
| project racePct
```

Type: **Threshold**, trigger `racePct >= 20`, checked every 60 minutes over the last 1440 minutes
(24h rolling window). Notifier: the shared email notifier above.

⚠ **`total >= 5` is a statistical-significance floor, not a business rule** — without it, a single
early race event reads as "100% of settlements are racing." It also means the monitor is
structurally silent below 5 no-usable-mandate events in a rolling day; that is intentional (no
signal, no page) but worth knowing if you're wondering why a real occurrence didn't alert.

⚠ **The `20` threshold is a provisional placeholder, not a measured value.** Nobody has a baseline
for how often this race actually fires — that is exactly what BAL-525 closed and what this
monitor exists to measure. Revisit once real data accumulates; tune down if 20% turns out to
under-alert, up if it's noisy.

---

## The `column_ifexists` requirement — a real Axiom gotcha, not stylistic

`mandateActiveAtCommit` had **never once been ingested** into `balo-logs` at build time (BAL-525
merged with low production volume since). Axiom's APL validates `where`/`summarize` field
references against the dataset's **historical** schema, not just against whether the current query
matches any rows — so a bare `mandateActiveAtCommit == true` reference fails outright with
`invalid field: "mandateActiveAtCommit"` even though the field is a real, intentional part of the
log shape and will appear the first time a matching event ships.

`column_ifexists("mandateActiveAtCommit", false)` sidesteps this: it evaluates to the field's
value once it exists in the schema, and to the literal `false` default until then. **This is the
correct construct here, not a workaround to remove later** — once the field has real occurrences
the query behaves identically either way, so there is nothing to "fix" once data arrives.

If a future signal's monitor query fails with `invalid field: "..."` and the field is real and
intentional (not a typo), this is almost certainly the same situation — wrap the reference in
`column_ifexists(fieldName, defaultValue)` rather than assuming the query is wrong.

---

## The dashboard tile

`Credit Settlement Monitors` dashboard, tile `BAL-545: Consent race rate (racePct) over time` —
signal 2's rate binned over time, so the dashboard answers "how much money has this defect been
costing?" (per BAL-535's open ruling) empirically rather than requiring a fresh query each time.

```kusto
['balo-logs']
| where msg == "Overdraft with no usable mandate AT SETTLEMENT TIME — opening receivable + dunning"
| summarize racePct = round(100.0 * countif(column_ifexists("mandateActiveAtCommit", false) == true) / count(), 1), total = count() by bin_auto(_time)
```

⚠ Axiom's timeseries-chart validator requires the **last** statement to be a `summarize ... by
bin(_time, ...)` (or `bin_auto(_time)`) with nothing after it — no trailing `extend`, only
`take`/`limit`/`top` are allowed post-summarize. That's why `racePct` is computed as a single
combined-aggregate expression inside the `summarize` itself rather than as a separate `extend`
step (which is how the monitor's own query above does it — the monitor has no such restriction).

Dashboard default time range: last 30 days.

---

## Where this feeds

Both signals feed [BAL-535](https://linear.app/balo-tech/issue/BAL-535)'s open ruling ("when a
client consumes time beyond their balance, who pays and how?"). Signal 2's rate in particular is
the empirical input to whether an authoritative pin is affordable — see the `account_hold`
consequence noted in PR #279 (a receivable blocks every subsequent session for that company, and a
client top-up does **not** clear it — only a succeeded `overdraft_settlement` PaymentIntent does).

---

## Known follow-ups (not done by this ticket)

- **The dashboard is currently Private** (visible only to the creating user) — this Axiom org's
  UI did not expose a discoverable way to change a dashboard's access to Organization after
  creation (unlike the three pre-existing dashboards, which are all `Organization`-scoped). A
  human with full Axiom admin access should re-share it, or recreate it from an Organization
  workspace context if one becomes available.
- **The notifier is a single engineer's email**, not a team destination. Replace with a Slack or
  PagerDuty notifier once the team has one provisioned in this Axiom org — there was none to
  route into at build time, contrary to the ticket's "wherever money-path alerts already go"
  premise (this org had no monitors, notifiers, or non-vendor dashboards at all before BAL-545).
- **No invariant-suite test pins either `msg` string.** Per the ticket's own instruction, one is
  only needed once a refactor actually reworks the wording — add it then, in
  `apps/api/src/invariants/`, following the pattern in `end-session.test.ts`'s existing coverage
  of these log lines.
