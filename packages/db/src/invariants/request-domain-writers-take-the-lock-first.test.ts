import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT (BAL-546 fix round R4) — MEMBERSHIP IN THE PER-REQUEST ADVISORY LOCK'S
 * SERIALISED SET IS MECHANICALLY FENCED, NOT PROSE-ENFORCED.
 *
 * `_shared/request-lock.ts`'s docblock names ELEVEN writers that must take
 * `acquireRequestLock` / `acquireRequestLockViaRelationshipTx` / `acquireRequestLockViaProposalTx`
 * as their transaction's FIRST LOCK — not necessarily its first statement (fix round R6; see
 * `_shared/request-lock.ts`'s own docblock for why those two are not the same claim). For every
 * one of the eleven, taking the lock call as the literal first statement of their `db.transaction(`
 * body is how that first-lock requirement is met in practice, and it is exactly that source-text
 * position this scan checks below. Before this file, that claim was
 * enforced only by a reviewer re-reading five source files and counting by eye — Group A of the
 * concurrency suite covers 5 of the 11, and the ticket this fix round answers exists BECAUSE a
 * membership rule stated in prose (D3/D13) missed a writer (`resubmit`) on its first pass. A
 * twelfth writer added to one of these five files without taking the lock first would compile,
 * pass every existing test, and silently reopen the exact AB/BA class this ticket closed.
 *
 * ⚠ WHY A SOURCE SCAN. There is no runtime signal that distinguishes "this writer takes the
 * lock first" from "this writer takes the lock second, after a row lock" — both look identical
 * to an integration suite that never races two real connections against every one of the eleven
 * (the concurrency suite proves interleaving for the writers it covers; it does not enumerate
 * every writer in these five files). A source scan is the only mechanical way to say "these
 * eleven, and NO OTHERS, open with the lock" without trusting a human recount.
 *
 * ⚠ THIS IS A GENUINE SET-EQUALITY OVER AN UNFILTERED DISCOVERY, NOT A HAND-PICKED ALLOWLIST.
 * `discoverWriters()` below does not start from the eleven names and check each is present — it
 * walks EVERY `db.transaction(` call site in the five request-domain files, resolves its
 * enclosing method, and records whether that method's first statement is one of the three lock
 * helpers. The eleven-item `EXPECTED_LOCK_TAKERS` list is compared against that full discovery
 * with `toEqual`, exactly like `an-account-hold-outlives-only-an-unpaid-balance.test.ts`'s
 * `ADVISORY_LOCK_CLASSES` carrier check. A writer that starts taking the lock, or one of the
 * eleven that stops, changes the DISCOVERED set and fails the comparison — the list cannot grow
 * or shrink silently in either direction.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST (`@balo/shared/testing`'s `stripComments`) — several of these
 * methods' own docblocks name `acquireRequestLock` in prose (to explain the rule), which would
 * otherwise trip a naive scan.
 *
 * ⚠ THIS FILE MUST NOT CONTAIN THE LITERAL `pg_advisory` ANYWHERE. It never needs to: every
 * check below goes through the three named helper SYMBOLS, never a raw SQL string. (This file
 * also lives under `invariants/`, not `repositories/`, so it is outside the two-lock-class
 * scan's walk regardless — but the discipline is followed anyway, for the same reason the
 * concurrency suite follows it: so a future copy-paste into `repositories/` doesn't trip it.)
 *
 * ⚠⚠ THE RESIDUAL, NAMED (fix round R8) — `TARGET_FILES` IS A HARDCODED FIVE-FILE LIST, NOT A
 * WALK OF `repositories/`. Unlike `an-account-hold-outlives-only-an-unpaid-balance.test.ts`'s
 * two-lock-class check (which walks EVERY `.ts` file under `repositories/` unfiltered, because it
 * only needs to grep for the literal `pg_advisory`), this scan is METHOD-GRAIN WITHIN FIVE NAMED
 * FILES. A brand-new SIXTH repository file containing a multi-table request-domain writer — one
 * that writes two-or-more of `proposals` / `request_expert_relationships` / `project_requests`
 * for one request, or inserts an open proposal — is INVISIBLE to this scan until a human adds its
 * filename to `TARGET_FILES`. Within the five named files, the coverage is real: a new or renamed
 * METHOD that skips the lock is caught by the set-equality check below. A wholly new FILE joining
 * the serialised set is not.
 *
 * ⚠ WHY THE STRONGER OPTION (an unfiltered discovery of "files that write the trio tables") WAS
 * TRIED AND REJECTED, NOT SKIPPED. The trio's writes are not always LEXICALLY LOCAL to the writing
 * file: `expressionsOfInterestRepository.submit` (`expressions-of-interest.ts`) writes
 * `request_expert_relationships` ONLY by calling `advanceRelationshipStatus`, an exported helper
 * DEFINED IN `request-expert-relationships.ts` — that file itself contains no
 * `.update(requestExpertRelationships)` / `.insert(requestExpertRelationships)` call site of its
 * own inside `submit`. A source-text scan for "which files call `.update(`/`.insert(` naming the
 * trio's schema symbols" would therefore MISS `expressions-of-interest.ts` entirely and disagree
 * with the (correct) hardcoded list — a false negative in the very direction this fix round exists
 * to close. Closing that gap for real needs either a full call graph (out of scope for a
 * source-text scan) or a curated list of known cross-file writer helpers to treat as proxies for
 * the tables they touch — which is itself just another hand-maintained list, no more
 * self-updating than `TARGET_FILES` is today. Given that, the hardcoded list plus this explicit
 * residual note is the more honest artifact than a "stronger-looking" scan that is quietly wrong
 * about a real writer that ships in this same file.
 */

const TARGET_FILES: readonly string[] = [
  'proposals.ts',
  'project-requests.ts',
  'request-expert-relationships.ts',
  'expressions-of-interest.ts',
  'project-engagements.ts',
];

/** The three, and only three, symbols that legitimately open a request-domain writer's lock. */
const LOCK_CALL_NAMES: readonly string[] = [
  'acquireRequestLockViaRelationshipTx',
  'acquireRequestLockViaProposalTx',
  'acquireRequestLock',
];

interface WriterRecord {
  readonly file: string;
  readonly method: string;
  /** The matched lock-helper name, or `undefined` when the method's transaction does not open
   *  with one of them. */
  readonly lockCall: string | undefined;
}

/**
 * The nearest enclosing `async <name>(` header before `beforeIndex` — i.e. the method whose
 * body contains the `db.transaction(` call site at `beforeIndex`. Object-literal repository
 * methods are not nested inside one another in this codebase, so "nearest preceding named async
 * header" is unambiguous. Deliberately does NOT match `async function name(` module-level
 * helpers (`readRequestBaloFeeBpsTx`, `lockOpenProposalsForRequestTx`, …): the word immediately
 * after `async ` there is the `function` keyword, not the helper's name, so `\s*\(` never finds
 * an opening paren directly after the captured identifier and the pattern fails to match at that
 * position — those helpers are correctly invisible to this scan, which only cares about
 * TRANSACTION-OPENING repository methods (`async submit(`, never `async function foo(`).
 *
 * ⚠⚠ THE CONSEQUENCE, NAMED — NOT JUST THE CAUSE (fix round R9). "Invisible" above understates
 * what happens if a `db.transaction(` call site is ever placed INSIDE a module-level
 * `async function <name>(` helper: this function does not throw for that call site. The `throw`
 * a few lines below only fires when NO preceding `async <name>(` header exists anywhere earlier
 * in the file — which will not happen in any of these five populated files, since a repository
 * method always precedes any later helper. Instead, `best` silently resolves to whichever NAMED
 * `async <method>(` header happens to be the NEAREST ONE PRECEDING that call site by index — the
 * `db.transaction(` call gets SILENTLY MISATTRIBUTED to that unrelated method's name, not
 * flagged as unscanned. A hand-rolled multi-table write hidden inside such a helper (called from
 * a transaction that does NOT open with the lock) could therefore pass this invariant by lending
 * its lock-taking (or lock-omitting) verdict to whatever method happens to sit above it in the
 * file, rather than being judged — or even counted — on its own.
 *
 * ⚠ NOT HYPOTHETICAL — THE SHAPE ALREADY EXISTS. `proposals.ts`'s `readRequestBaloFeeBpsTx` and
 * `lockOpenProposalsForRequestTx` are exactly this shape today (module-level `async function`
 * helpers called from inside the repository's `db.transaction(` bodies). Neither currently
 * contains a `db.transaction(` call site of its own, so no misattribution occurs on `main` right
 * now — but nothing in this file's mechanics would catch it if one of them, or a future helper
 * like them, ever grew one.
 *
 * Detecting `async function <name>(` and attributing its body's call sites correctly (or
 * throwing on them) was considered and deliberately NOT done here: the two known helpers above
 * never themselves open a transaction, so a detector would have nothing to exercise today, and a
 * regex reliably distinguishing "this call site is lexically inside helper X's body" from
 * "helper X merely precedes it in the file" needs brace-depth tracking, not another one-line
 * pattern — a real cost for a residual that is documented, not silent, as of this fix round.
 */
function enclosingMethodName(stripped: string, beforeIndex: number): string {
  const pattern = /\basync\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let best: { index: number; name: string } | undefined;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined && match.index < beforeIndex) {
      if (best === undefined || match.index > best.index) {
        best = { index: match.index, name };
      }
    }
    match = pattern.exec(stripped);
  }
  if (best === undefined) {
    throw new Error(
      `No enclosing "async <name>(" header found before index ${beforeIndex}. A db.transaction( ` +
        'call site outside any named method is unexpected in these repository files — investigate ' +
        'rather than silencing this.'
    );
  }
  return best.name;
}

/**
 * Whether the text immediately following a `db.transaction(` call's `=>` (skipping whitespace
 * and one optional opening `{`) begins with one of the three lock helpers — the transaction's
 * first statement, braced (`async (tx) => { await acquireRequestLock(...` ) or braceless
 * (`(tx) => someOtherCall(...)`) alike. Returns the matched helper name, or `undefined`.
 */
function firstLockCall(stripped: string, transactionIndex: number): string | undefined {
  const arrowIndex = stripped.indexOf('=>', transactionIndex);
  if (arrowIndex === -1) {
    throw new Error(`No "=>" found after db.transaction( at index ${transactionIndex}.`);
  }
  let i = arrowIndex + 2;
  const isWhitespace = (char: string): boolean =>
    char === ' ' || char === '\n' || char === '\t' || char === '\r';
  while (i < stripped.length && isWhitespace(stripped.charAt(i))) i += 1;
  if (stripped.charAt(i) === '{') {
    i += 1;
    while (i < stripped.length && isWhitespace(stripped.charAt(i))) i += 1;
  }
  const window = stripped.slice(i, i + 160);
  const withoutAwait = window.startsWith('await ') ? window.slice('await '.length) : window;
  for (const name of LOCK_CALL_NAMES) {
    if (withoutAwait.startsWith(`${name}(`)) return name;
  }
  return undefined;
}

/** Every `db.transaction(` call site across the five request-domain repository files, with its
 *  enclosing method and (if any) the lock helper it opens with. An UNFILTERED discovery — every
 *  call site in these files is recorded, not just the ones this suite expects to find. */
function discoverWriters(): WriterRecord[] {
  const records: WriterRecord[] = [];
  for (const file of TARGET_FILES) {
    const raw = readFileSync(
      fileURLToPath(new URL(`../repositories/${file}`, import.meta.url)),
      'utf8'
    );
    const stripped = stripComments(raw);
    let from = 0;
    for (;;) {
      const idx = stripped.indexOf('db.transaction(', from);
      if (idx === -1) break;
      const method = enclosingMethodName(stripped, idx);
      const lockCall = firstLockCall(stripped, idx);
      records.push({ file, method, lockCall });
      from = idx + 'db.transaction('.length;
    }
  }
  return records;
}

/**
 * The eleven named writers (orchestrator D13) — cross-checked against `discoverWriters()`'s
 * exhaustive walk, never trusted alone. `resubmit` and `createDraft` are here even though the
 * membership RULE they satisfy is "inserts an open proposal onto a request" rather than "writes
 * two-or-more tables" (fix round R3) — this scan does not care which arm of the rule justified a
 * writer's inclusion, only whether it takes the lock first.
 */
const EXPECTED_LOCK_TAKERS: readonly string[] = [
  'proposals.ts:submit',
  'proposals.ts:createDraft',
  'proposals.ts:promoteToSubmit',
  'proposals.ts:accept',
  'proposals.ts:resubmit',
  'project-requests.ts:close',
  'request-expert-relationships.ts:invite',
  'request-expert-relationships.ts:declineTrack',
  'request-expert-relationships.ts:transitionStatus',
  'expressions-of-interest.ts:submit',
  'project-engagements.ts:materializeFromKickoff',
]
  .slice()
  .sort();

describe('INVARIANT: the eleven request-domain writers, and only these, take the per-request advisory lock first (BAL-546, D13, fix round R4)', () => {
  const records = discoverWriters();

  it('⚠ POSITIVE CONTROL — the scan finds more db.transaction( sites than the eleven (non-vacuity)', () => {
    // If this ever shrinks to ⇐ 11, the discovery loop itself is broken (e.g. an early break),
    // and the set-equality assertion below would no longer be exercising real discrimination.
    expect(records.length).toBeGreaterThan(EXPECTED_LOCK_TAKERS.length);
  });

  it('⚠ POSITIVE CONTROL — a known OUT-of-set writer is correctly detected as NOT lock-first', () => {
    // `proposalsRepository.transitionStatus` is the single-row request writer the D3/D13 OUT
    // list names explicitly. If the matcher were vacuously true for anything, this would fail.
    const outOfSet = records.find(
      (r) => r.file === 'proposals.ts' && r.method === 'transitionStatus'
    );
    expect(outOfSet).toBeDefined();
    expect(outOfSet?.lockCall).toBeUndefined();
  });

  it('the discovered lock-first writer set equals the eleven named writers exactly', () => {
    const discovered = records
      .filter((r) => r.lockCall !== undefined)
      .map((r) => `${r.file}:${r.method}`)
      .sort();
    expect(discovered).toEqual(EXPECTED_LOCK_TAKERS);
  });

  it.each(EXPECTED_LOCK_TAKERS)(
    'uses one of the three acquireRequestLock* helpers, never a hand-rolled call: %s',
    (key) => {
      const record = records.find((r) => `${r.file}:${r.method}` === key);
      expect(record, `expected a db.transaction( call site for ${key}`).toBeDefined();
      expect(record?.lockCall).toBeDefined();
    }
  );
});
