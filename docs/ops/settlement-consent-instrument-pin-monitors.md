# Settlement consent + instrument-pin Axiom monitors — ops runbook

**Audience:** Balo admins and on-call engineers. Internal operations document, not customer-facing
help copy (that lives in `docs/help/`).

Covers the two Axiom monitors and the dashboard tile shipped for **BAL-545**, a residual of
[BAL-525](https://linear.app/balo-tech/issue/BAL-525) (PR #279, `apps/api/src/services/credit-session/end-session.ts`).
BAL-525 added two log lines on the settlement money path that were **inert until something
watched them** — a detection surface with no detector is not a control. BAL-545 is that detector.

**The log lines pre-existed this ticket.** BAL-545 added only the drift guard around them — the
exported `SETTLEMENT_*_MSG` constants and the verbatim pinning test in `end-session.test.ts` — and
this doc records the Axiom-side configuration built on top of them.

---

## What was actually built

Before this ticket, this Axiom org (`balo-6ibo`) had **zero monitors, zero notifiers, and zero
dashboards of its own** — only the vendor-installed demo dashboards. These are the first ones.
There was no existing "money-path alert" destination to route into (the ticket's premise that one
already existed did not hold — see **Known follow-ups (not done by this ticket)** at the bottom).

| What               | Name                                                                                   | Kind      | Link                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| Notifier           | `BAL-545 money-path alerts (email)`                                                    | Email     | Axiom → Monitors → Notifiers                                                         |
| Monitor (signal 1) | `BAL-545: Settlement instrument pin disagreement`                                      | Match     | `https://app.axiom.co/balo-6ibo/monitors/view/iqVhZL1NXF0Oi9Duy0`                    |
| Monitor (signal 2) | `BAL-545: Settlement consent race rate (mandate active at commit, gone by settlement)` | Threshold | `https://app.axiom.co/balo-6ibo/monitors/view/reELyiGGQKbPMtD7fJ`                    |
| Dashboard          | `Credit Settlement Monitors`                                                           | —         | `https://app.axiom.co/balo-6ibo/dashboards/uid/1cbd93fc-4b21-4235-89f7-fc2ef15dd8da` |

The notifier is a single shared Email notifier to the on-call engineer's address, reused by both
monitors. **Follow-up (see below): wire a real team destination** (Slack/PagerDuty) once one
exists — email was the only zero-setup option available at build time. End-to-end delivery was verified 2026-09-07 via the notifier's Test action — the test email arrived in the inbox.

---

## The two signals

Both emitted from `settleOverdraft` (`apps/api/src/services/credit-session/end-session.ts`),
dataset `balo-logs`. Both monitors match `msg` by **exact string equality**, so a reworded string
kills its monitor silently — no error, no page, just zero rows forever. The drift guard lives in
the code, not in Axiom: the two monitored strings plus the third line below are exported from
`end-session.ts` as `SETTLEMENT_NO_USABLE_MANDATE_MSG`,
`SETTLEMENT_MANDATE_REVIVED_MSG`, and `SETTLEMENT_PIN_DISAGREES_MSG`; the `log.*` calls use those
constants, and `end-session.test.ts` pins each constant against a full **literal** copy of the
string — the duplication is deliberate — so any reword fails CI. Code, test, and this runbook
share one source of truth.

⚠ **Rewording a monitored string is a four-place change, made together:** the constant, the
literal in the test, the monitor's query in Axiom, and this doc — three places for the
un-monitored third line, which has no Axiom query. The advice previously given here
— pin it "following `end-session.test.ts`'s existing coverage", or add it to the invariant suite —
was wrong on both counts: that coverage was `expect.stringContaining` fragments, which a reword
can sail through, and a full-literal `includes` scan of the source (the `apps/api/src/invariants/`
pattern) would have missed signal 1, because it was written as two concatenated literals joined
with `+`.

### Signal 1 — instrument-pin disagreement (Match monitor, alerts on any occurrence)

```
msg == "Settlement instrument pin disagrees with the wallet — charging the live instrument (BAL-525: the pin is evidence and preference, never authority)"
```

Fields (from the code, not the ticket): `op`, `sessionId`, `walletId`, `overdraftMinor`,
`pinnedCustomerId`, `pinnedPaymentMethodId`, `liveCustomerId`, `livePaymentMethodId`, `pinnedAt`,
`mandateActiveAtCommit`. On-call wants `overdraftMinor` first (the amount at stake), then
`liveCustomerId` — a mismatch on the customer id alone, payment-method id unchanged, is
undiagnosable without it.

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

The no-usable-mandate branch — `msg == "Overdraft with no usable mandate AT SETTLEMENT TIME — opening receivable + dunning"` —
fires on **every** settlement with no usable mandate, regardless
of history. The race BAL-525 closed is the **subset** where `mandateActiveAtCommit == true`:
consent was live when the debt was computed and gone by the time settlement ran.

Volume of the no-usable-mandate branch overall is expected to be non-zero (a client can
legitimately revoke or detach mid-session, or never have had a mandate at all), so this wants a
**rate**, not `count > 0` — otherwise it pages on normal traffic.

The denominator (`total`) also counts reconcile-path settlements — `reconcileStuckSettlement`
re-invokes `settleOverdraft` with `mandateActiveAtCommit: null` (no in-lock observation; the
commit was hours ago) — and `null == true` never matches, so those rows land in `total` but can
never reach `race`: a small dilution of `racePct`, negligible at current volume.

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
(24h rolling window). Notifier: the shared email notifier above. **"Alert on no data": OFF** (left
at Axiom's default — see the next warning for why that setting is load-bearing).

⚠ **`total >= 5` is a statistical-significance floor, not a business rule** — without it, a single
early race event reads as "100% of settlements are racing." Below 5 no-usable-mandate events in a
rolling day the query returns **zero rows**, not a zero `racePct`, so the monitor is structurally
silent there — and it is silent **only because "Alert on no data" is OFF**. Turning that on would
page every quiet day, since a day with fewer than 5 such settlements is a day with no rows. The
silence is intentional (no signal, no page) but worth knowing if you're wondering why a real
occurrence didn't alert.

⚠ **The `20` threshold is a provisional placeholder, not a measured value.** Nobody has a baseline
for how often this race actually fires — that is exactly what BAL-525 closed and what this
monitor exists to measure. Revisit once real data accumulates; tune down if 20% turns out to
under-alert, up if it's noisy.

### The third line — mandate revived by settlement time (NO monitor, deliberately)

```
msg == "Overdraft mandate went from inactive at commit to active at settlement — charging on the fresh mandate"
```

`log.info`, fired when `mandateActiveAtCommit == false` and the live re-read finds
`mandateActiveNow == true` — the "#279 Qodo mirror" of signal 2's warn. Fields: `op`, `sessionId`,
`walletId`, `overdraftMinor`, `mandateActiveAtCommit`, `mandateActiveNow`.

**No monitor keys on this line, and that is deliberate.** It is the expected-and-correct outcome
of re-reading consent live at settlement (BAL-525 O3's whole point), not an anomaly — an operator
has nothing to act on, and paging on it would only teach people to ignore the notifier. It is
exported and literal-pinned exactly like the other two (`SETTLEMENT_MANDATE_REVIVED_MSG`), so the
string stays stable and greppable in Axiom even without a monitor.

A dashboard tile counting it — the **benefit** side of BAL-525 O3, next to `racePct`'s cost side
— is an optional follow-up, **not done**.

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
- **No dashboard tile counts the third line** (`SETTLEMENT_MANDATE_REVIVED_MSG`, the benefit
  side of BAL-525 O3). Optional; if added, it belongs on `Credit Settlement Monitors` next to the
  `racePct` tile so cost and benefit read side by side.
