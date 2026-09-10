/**
 * BAL-548 / ADR-1055 — THE EVIDENCE SNAPSHOT stored on `admin_alerts.detail`.
 *
 * ⚠⚠ THIS FILE IS THE `jsonb` COLUMN'S TYPE, AND IT IS DELIBERATELY THE ONLY PART OF THE
 * KIND REGISTRY THAT EXISTS TODAY. `packages/db/src/schema/admin-alerts.ts` value-owns the
 * column and TYPE-imports this shape; the rest of the registry (groups, kinds, cadences,
 * targets, storm helpers, the sentinel) lands beside it in this same directory and must
 * NOT redefine `AdminAlertDetail` or `AdminAlertMoney`.
 *
 * `packages/shared` imports NO db, no `node:crypto`, no React, no I/O — the standing rule
 * stated in `packages/shared/src/reviews/index.ts`'s header. This module is pure data.
 *
 * ⚠⚠ THE ROW'S WHOLE VISIBLE CONTENT, SNAPSHOTTED AT THE MOMENT THE PROBLEM WAS FOUND.
 *
 * ADR-1055: "keeps the evidence as it was when the problem was found … `detail` is an
 * evidence snapshot, because pointers go stale". The SENTENCE is evidence too: a row that
 * re-derived its title from live data would say something different from what the responder
 * read yesterday, and for `topup.unresolved_pi` the pointer it would need
 * (`pending_topup_triggering_entry_id`) is erased by the 15-minute marker re-arm. So the
 * PRODUCER writes all of it, once.
 *
 * ⚠ CONSEQUENCE, STATED SO IT IS NOT REDISCOVERED AS A BUG: a row's copy does not improve
 * when the copy is improved. Rows written before a wording change keep the old wording until
 * they resolve. That is the correct trade for evidence that must not drift.
 *
 * ⚠ EVERY FIELD IS A PLAIN STRING OR AN ARRAY OF STRINGS — NO `Date`, NO number that must
 * round-trip. Drizzle types a `jsonb().$type<T>()` read as `T`, but the driver hands back
 * parsed JSON: a `Date` inside a jsonb type is a documented lie in this repo
 * (`transcripts.ExtractedActionItem.dueAt` makes the same call, for the same reason).
 */
export interface AdminAlertDetail {
  /** The title sentence a person understands. Line 1 of the row. */
  readonly title: string;
  /** "Priya Nair @ CloudPeak" — the THING this is about. Retrospective ⇒ person "@ org". */
  readonly entityLabel: string;
  /** The one-line evidence sentence, line 3 of the row. */
  readonly evidence: string;
  /**
   * `[label, value]` pairs revealed when the row expands. Ordered; 2-6 entries.
   *
   * ⚠⚠ A-F7 — NOT FEE-CONCEALED. This is producer-authored free text, rendered VERBATIM to
   * ANY actor holding `VIEW_PLATFORM_ADMIN` — no schema, no strip, no length bound.
   * `apps/web`'s `stripMoney` (`admin-queue-view.ts`) strips exactly the three NAMED fields on
   * {@link AdminAlertMoney} below and nothing else; it does not, and structurally cannot,
   * sanitize this array's contents. An earnings/margin/markup FIGURE belongs in
   * `AdminAlertMoney`'s own named fields, never here.
   * `packages/db/src/invariants/admin-alert-facts-are-not-fee-concealed.test.ts` asserts no
   * shipped producer writes that vocabulary into a `facts` array.
   */
  readonly facts: readonly (readonly [string, string])[];
  /**
   * The ROUTABLE id when it differs from `admin_alerts.entity_id` — e.g. the recording and
   * transcript kinds are keyed on the artefact (that is the grain that can be fixed) but
   * deep-link to the meeting. Absent ⇒ the target is `entity_id` itself.
   */
  readonly targetId?: string;
  /** Present only on `group: 'money'` kinds. Pre-formatted currency strings. */
  readonly money?: AdminAlertMoney;
}

/**
 * ⚠ PRE-FORMATTED STRINGS, NOT MINOR UNITS. These are a snapshot of what was true;
 * re-formatting them later against a changed display-FX rate would silently rewrite history.
 *
 * ⚠ `expert` AND `margin` ARE FEE-CONCEALED. They are stored (this table is staff-only) but
 * the SERVER strips them from the view model for an actor without `MANAGE_PLATFORM_FEES` —
 * they must never reach a non-holder's RSC payload. A render gate is not enough: a Server
 * Component's props land in the payload either way, so concealment is a STRIP.
 */
export interface AdminAlertMoney {
  readonly client: string;
  readonly expert: string;
  readonly margin: string;
  readonly markup: string;
  /**
   * One extra `[label, value]` line, e.g. `['Overdraft settled', 'A$62.40 — failed']`.
   *
   * ⚠⚠ A-F7 — NOT FEE-CONCEALED, INCLUDING IN THE CONCEALED BRANCH. `stripMoney`
   * (`apps/web`'s `admin-queue-view.ts`) nulls exactly `expert`, `margin` and `markup` — it
   * passes `extra` through UNCHANGED even when concealing the rest of this object. Producer
   * discipline is the only thing keeping an earnings/margin/markup figure out of this field;
   * it must never carry one.
   */
  readonly extra?: readonly [string, string];
}
