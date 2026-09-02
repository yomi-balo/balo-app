import { describe, expect, it } from 'vitest';
import { ALL_SOURCE_FILES, codeLines, readRaw } from './_source-scan.js';

/**
 * ⚠⚠ INVARIANT — **A SESSION MARKED `settlement_status='settled'` IMPLIES A `credit_ledger` ROW
 * KEYED `overdraft_settlement:{sessionId}`.**
 *
 * ⚠ THE BUG THAT CREATED THIS FILE. `markSettledFromReconcile` used to mark a session `settled`
 * and CLEAR its receivable while DEFERRING the ledger credit to the `payment_intent.succeeded`
 * webhook. That deferral is only sound if a failed webhook is retried — and a webhook can
 * permanently fail while still returning HTTP 200, in which case Stripe never redelivers. The row
 * then reads `settled` (and `settlement_status` is on the CLIENT allow-list, `credit-views.ts`),
 * dunning stops, the receivable is gone, and NO ledger row exists for money Stripe actually took.
 * The debt is unrecoverable from the database alone.
 *
 * ⚠ AND THE CLEAR IS IRREVERSIBLE. `creditReceivablesRepository.open`'s conflict fallback and the
 * partial unique behind it are STATUS-BLIND, so a cleared row permanently occupies the
 * one-per-session slot: every later `open` returns `created:false` ⇒ dunning can never fire for
 * that session again. There is no second chance to re-open the debt.
 *
 * THREE THINGS NOW HOLD IT, AND THIS FILE PINS ALL THREE:
 *   A. There are exactly TWO writers of `settled` in `apps/api`, and no more. A third writer is
 *      precisely how this reappears — a new reconcile-shaped path that marks first and credits
 *      later would be invisible to every other test in the repo.
 *   B. `dispatch.ts`'s writer marks through the CALLER'S transaction handle (`tx`), never through
 *      the module-level `db`. That is what makes the mark + receivable clear atomic with the
 *      ledger insert: they commit together or not at all.
 *   C. `end-session.ts`'s writer VERIFIES the credit first (`findByIdempotencyKey`) and, when it
 *      is absent, applies it through the same pipeline (`applyOverdraftSettlementFromStripe`)
 *      rather than marking on faith.
 *
 * ⚠ WHY A SOURCE SCAN AND NOT A DATABASE ASSERTION. The invariant is about WRITE PATHS, not about
 * the rows that happen to exist: a database snapshot is clean right up until the moment the bad
 * path runs. `packages/db/src/repositories/credit-sessions.integration.test.ts` proves the
 * DETECTOR (`findSettledMissingLedgerCredit`) finds a violating row against real Postgres; this
 * file is what stops one being written in the first place.
 *
 * If this test fails: do NOT add a file to the list below to make it pass. Either the new writer
 * belongs inside the ledger transaction (route it through `markSettlementSettled`), or it needs
 * the same verify-then-apply guard `markSettledFromReconcile` uses.
 */

/** The `status: 'settled'` literal as it appears in a `markSettlementResult` payload. */
const SETTLED_MARKER = "status: 'settled'";

const DISPATCH = 'services/stripe/dispatch.ts';
const END_SESSION = 'services/credit-session/end-session.ts';

/**
 * The ONLY two files allowed to mark a session `settled`.
 *
 * ⚠ THIS IS AN EXPECTED SET, NOT AN ALLOW-LIST TO GROW. The assertion below is an EQUALITY, so a
 * new writer fails here AND a writer that disappears (e.g. the repair arm being deleted) fails
 * here too — the second direction is what keeps the scan from going vacuous.
 */
const EXPECTED_SETTLED_WRITERS: readonly string[] = [DISPATCH, END_SESSION];

describe('INVARIANT: settled implies a ledger credit', () => {
  it('A. exactly two files in apps/api mark a session settled', () => {
    const writers = ALL_SOURCE_FILES.filter((rel) =>
      codeLines(readRaw(rel)).includes(SETTLED_MARKER)
    ).sort((a, b) => a.localeCompare(b));
    expect(writers).toEqual([...EXPECTED_SETTLED_WRITERS].sort((a, b) => a.localeCompare(b)));
  });

  /**
   * NON-VACUITY. `ALL_SOURCE_FILES` comes from a directory WALK, not a pinned list, so a broken
   * walk (or a marker that stopped matching after a reformat) would make Scan A pass with an
   * empty set on both sides. Pin the floor explicitly.
   */
  it('A(control). the walk is non-empty and the marker really matches', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(100);
    expect(ALL_SOURCE_FILES).toContain(DISPATCH);
    expect(ALL_SOURCE_FILES).toContain(END_SESSION);
    expect(codeLines(readRaw(DISPATCH))).toContain(SETTLED_MARKER);
    expect(codeLines(readRaw(END_SESSION))).toContain(SETTLED_MARKER);
  });

  it('B. dispatch marks through the caller transaction, never the module-level db', () => {
    const code = codeLines(readRaw(DISPATCH));
    // The mark rides the SAME handle the ledger insert used ⇒ atomic with the credit.
    expect(code).toContain('creditSessionsRepository.markSettlementResult(tx, {');
    expect(code).toContain('creditReceivablesRepository.clear({ sessionId }, tx)');
    // A `db`-handled mark would commit independently of the ledger row — the whole hazard.
    expect(code).not.toContain('creditSessionsRepository.markSettlementResult(db,');
  });

  it('C. the reconcile path verifies the credit before it marks or clears anything', () => {
    const code = codeLines(readRaw(END_SESSION));
    // It looks the credit up under the one shared idempotency key…
    expect(code).toContain('creditLedgerRepository.findByIdempotencyKey(');
    expect(code).toContain("reason: 'overdraft_settlement',");
    // …and, finding none, applies it through the webhook pipeline rather than marking on faith.
    expect(code).toContain('applyOverdraftSettlementFromStripe(');
    // The mark is DOWNSTREAM of the lookup — a mark above it would be the old unconditional one.
    const lookupAt = code.indexOf('creditLedgerRepository.findByIdempotencyKey(');
    const markAt = code.indexOf(SETTLED_MARKER);
    expect(lookupAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(lookupAt);
  });

  /**
   * The detector's other half: an alarm nobody runs is not an alarm. `findSettledMissingLedgerCredit`
   * exists so a row already corrupted in production (or written by a future third writer) is
   * reported rather than sitting silently — pin that the sweep actually calls it.
   */
  it('D. the meter sweep runs the settled-without-credit alarm', () => {
    const code = codeLines(readRaw('jobs/credit-session-meter-sweep.ts'));
    expect(code).toContain('creditSessionsRepository.findSettledMissingLedgerCredit(');
  });
});
