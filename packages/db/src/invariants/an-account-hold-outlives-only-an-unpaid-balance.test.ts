import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creditCoversOutstandingDebt } from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — A COMPANY'S SOFT ACCOUNT HOLD OUTLIVES ONLY AN UNPAID BALANCE, AND ONLY THE
 * COMPANY'S OWN CASH CAN END IT. ADR-1040 Amendment 6 §F/§G (BAL-535): a cash-funded credit that
 * returns the wallet to a non-negative CASH-BACKED balance clears every open receivable on that
 * wallet, in the SAME transaction as the ledger write that covered it — releasing the company's
 * soft hold. A marketing grant never can.
 *
 * ⚠ THIS FILE CREATES THE INVARIANT; IT DOES NOT AMEND ONE. Before BAL-535 an open
 * `credit_receivables` row had NO self-service exit: a top-up did not clear it, the dunning
 * sweep never re-charged it, and `findStuckSettling` could not see it. Per ADR-1032 steps 1–2,
 * this suite was AUTHORED AND RUN RED before `creditCoversOutstandingDebt`
 * (`packages/shared/src/credit/receivable-coverage.ts`) and `clearReceivablesCoveredByCredit`
 * (`apps/api/src/services/stripe/dispatch.ts`) existed — that failure was expected and correct.
 * The predicate, the repository methods, and the webhook wiring all ship together in THIS commit,
 * so a reader on `main` finds this suite green, not red.
 *
 * ⚠⚠ FIX-ROUND B1 REWROTE PART 2, ON THE RECORD. §F originally called the promo exclusion
 * "structural rather than conditional" because R3 read the balance upstream of the bundled promo
 * grant. That was true of a promo bundled onto THAT purchase and false of every other one: a
 * grant from an earlier transaction (including the standalone Model-C redeem in
 * `apps/web/.../redeem/_actions/redeem-promo.ts`, which has no purchase and no receivable gate)
 * is already inside the aggregate `balance_minor`, so one cent of cash discharged a $50
 * receivable — and the two R3b sites had no cash gate whatsoever, reading committed wallet state
 * that includes every promo adjustment ever made. The exclusion is now a DISCOUNT carried in the
 * predicate's signature. The assertions that pinned the old ordering argument are replaced, not
 * relaxed: the count they guarded moved into a single shared module and is pinned there instead.
 *
 * Five independent claims, each failing by name — see the `describe` blocks below:
 *  1. The pure core: the predicate is the wallet's resulting BALANCE minus promo `>= 0`, never
 *     the receivable's `amount_minor` (design question (a) / (b)).
 *  2. The reason set is CASH-ONLY (`manual_purchase`, `auto_topup`) and the promo exclusion is
 *     REAL — one discount, one shared coverage module, three call sites that cannot disagree
 *     (design question (d), fix round B1).
 *  3. Both late-open (R3b) transactions take the wallet advisory lock FIRST, so the clear
 *     serialises against the credit path rather than racing it (fix round M2).
 *  4. The one-per-session receivable unique stays STATUS-BLIND, so a cleared row can never be
 *     re-opened (§F final paragraph / design question (f)).
 *  5. An open receivable never coexists with a `processing` settlement — every opening site
 *     marks the session terminal in the SAME transaction it opens the receivable in (§G.1).
 */

/** See `session-debt-carries-its-collection-instrument.test.ts` for the rationale in full. */
function readScannedSourceOrFail(displayPath: string, url: URL): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-535 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        `an-account-hold-outlives-only-an-unpaid-balance.test.ts rather than letting the scan ` +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

/** Every `.ts` file under `dir`, recursively — the repository sweep the lock-class scan needs. */
function listTsFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFilesRecursive(abs);
    return entry.isFile() && abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Whitespace-normalised variant — for assertions that must survive a Prettier rewrap. */
function normalize(src: string): string {
  return src.replace(/\s+/g, ' ');
}

/**
 * CODE ONLY — block and line comments removed. Used by the assertions whose claim is about what
 * the code DOES, so that a docblock naming the very identifier the code must not read (or a
 * comment quoting a SQL call) cannot break them, and — more importantly — cannot satisfy them.
 * Both patterns exclude their own delimiters and use a lazy body, so neither is super-linear
 * (SonarCloud S5852).
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const SHARED_PREDICATE_DISPLAY_PATH = 'packages/shared/src/credit/receivable-coverage.ts';
const SHARED_PREDICATE_URL = new URL(
  '../../../shared/src/credit/receivable-coverage.ts',
  import.meta.url
);

const COVERAGE_SERVICE_DISPLAY_PATH = 'apps/api/src/services/credit/receivable-coverage.ts';
const COVERAGE_SERVICE_URL = new URL(
  '../../../../apps/api/src/services/credit/receivable-coverage.ts',
  import.meta.url
);

const DISPATCH_DISPLAY_PATH = 'apps/api/src/services/stripe/dispatch.ts';
const DISPATCH_URL = new URL(
  '../../../../apps/api/src/services/stripe/dispatch.ts',
  import.meta.url
);

const END_SESSION_DISPLAY_PATH = 'apps/api/src/services/credit-session/end-session.ts';
const END_SESSION_URL = new URL(
  '../../../../apps/api/src/services/credit-session/end-session.ts',
  import.meta.url
);

describe('INVARIANT: an account hold outlives only an unpaid balance — pure core (creditCoversOutstandingDebt)', () => {
  interface Row {
    label: string;
    balanceMinorAfterCredit: number;
    /** Promo granted since the debt opened — the discount that makes §F's exclusion real. */
    promoGrantedSinceDebtMinor: number;
    /** Carried for readability only — NOT read by the predicate (anti-collapse #2 pins this). */
    receivableAmountMinor: number;
    expected: boolean;
  }

  const ROWS: readonly Row[] = [
    {
      label: 'a large negative balance — nowhere close',
      balanceMinorAfterCredit: -50_000,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 50_000,
      expected: false,
    },
    {
      label: 'a small negative balance after a PARTIAL top-up on a small receivable',
      balanceMinorAfterCredit: -1,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 100,
      expected: false,
    },
    {
      label:
        'a small negative balance even though the receivable amount is TINY (anti-collapse #1 fodder)',
      balanceMinorAfterCredit: -100,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 1,
      expected: false,
    },
    {
      label: 'exactly zero — the boundary is >= 0, not > 0',
      balanceMinorAfterCredit: 0,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 5_000,
      expected: true,
    },
    {
      label: 'a small positive balance — the credit more than covered it',
      balanceMinorAfterCredit: 1,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 5_000,
      expected: true,
    },
    {
      label: 'a large positive balance',
      balanceMinorAfterCredit: 100_000,
      promoGrantedSinceDebtMinor: 0,
      receivableAmountMinor: 5_000,
      expected: true,
    },
    {
      label:
        '⚠⚠ B1 — a $50 promo plus ONE CENT of cash does NOT clear a $50 debt (the shipped defect)',
      balanceMinorAfterCredit: 1,
      promoGrantedSinceDebtMinor: 5_000,
      receivableAmountMinor: 5_000,
      expected: false,
    },
    {
      label: '⚠⚠ B1 — a promo alone, landing on an exactly-zero balance, does NOT clear',
      balanceMinorAfterCredit: 0,
      promoGrantedSinceDebtMinor: 5_000,
      receivableAmountMinor: 5_000,
      expected: false,
    },
    {
      label: '⚠⚠ B1 — cash that covers the debt ON TOP OF a promo still clears',
      balanceMinorAfterCredit: 5_000,
      promoGrantedSinceDebtMinor: 5_000,
      receivableAmountMinor: 5_000,
      expected: true,
    },
    {
      label: '⚠⚠ B1 — one cent short of covering it on top of a promo does NOT clear',
      balanceMinorAfterCredit: 4_999,
      promoGrantedSinceDebtMinor: 5_000,
      receivableAmountMinor: 5_000,
      expected: false,
    },
  ];

  it.each(ROWS)('$label', ({ balanceMinorAfterCredit, promoGrantedSinceDebtMinor, expected }) => {
    expect(creditCoversOutstandingDebt(balanceMinorAfterCredit, promoGrantedSinceDebtMinor)).toBe(
      expected
    );
  });

  it('⚠⚠ ANTI-COLLAPSE #1 — a PARTIAL credit never clears, named by label not merely by count', () => {
    // An "any top-up clears" implementation collapses this set and fails HERE, by name.
    const negativeRowsThatClear = ROWS.filter(
      (row) =>
        row.balanceMinorAfterCredit < 0 &&
        creditCoversOutstandingDebt(row.balanceMinorAfterCredit, row.promoGrantedSinceDebtMinor)
    );
    expect(negativeRowsThatClear.map((row) => row.label)).toEqual([]);
    // Restated positively so this test independently fails if the negative-balance set is ever
    // emptied out from under it (e.g. every ROW accidentally made non-negative).
    const negativeRows = ROWS.filter((row) => row.balanceMinorAfterCredit < 0);
    expect(negativeRows.length).toBeGreaterThan(0);
  });

  it('⚠⚠ ANTI-COLLAPSE #1b (B1) — NO promo-funded row ever clears, named by label', () => {
    // Deleting the subtraction (`return balanceMinorAfterCredit >= 0;`) fails HERE, by name, with
    // the three promo-funded labels printed — not merely as a changed count.
    const promoFundedThatClear = ROWS.filter(
      (row) =>
        row.promoGrantedSinceDebtMinor > 0 &&
        row.balanceMinorAfterCredit - row.promoGrantedSinceDebtMinor < 0 &&
        creditCoversOutstandingDebt(row.balanceMinorAfterCredit, row.promoGrantedSinceDebtMinor)
    );
    expect(promoFundedThatClear.map((row) => row.label)).toEqual([]);
    // And the set it judges is non-empty, so emptying the table cannot make it vacuous.
    expect(ROWS.filter((row) => row.promoGrantedSinceDebtMinor > 0).length).toBeGreaterThan(0);
  });

  it('⚠⚠ ANTI-COLLAPSE #2 — the predicate cannot see the receivable amount', () => {
    // Arity 2 (balance + promo discount) since B1; a third parameter, or a re-read of the
    // receivable's own figure, fails here.
    expect(creditCoversOutstandingDebt).toHaveLength(2);
    // CODE only — the docblock legitimately NAMES `amount_minor` to explain why the predicate
    // must never read it, and a prose mention must neither break this nor satisfy it.
    const src = codeOnly(
      readScannedSourceOrFail(SHARED_PREDICATE_DISPLAY_PATH, SHARED_PREDICATE_URL)
    );
    expect(src).not.toContain('amountMinor');
    expect(src).not.toContain('amount_minor');
  });

  it('⚠⚠ ANTI-COLLAPSE #3 (B1) — the promo discount is a REQUIRED parameter, not an optional one', () => {
    // The whole force of B1 is that a call site cannot ASK the question without naming the
    // discount. `promoGrantedSinceDebtMinor?:` or a `= 0` default would silently restore the
    // shipped defect at every site that forgot it; both fail here.
    const src = normalize(
      readScannedSourceOrFail(SHARED_PREDICATE_DISPLAY_PATH, SHARED_PREDICATE_URL)
    );
    expect(src).toContain('promoGrantedSinceDebtMinor: number');
    expect(src).not.toContain('promoGrantedSinceDebtMinor?:');
    expect(src).not.toContain('promoGrantedSinceDebtMinor: number = ');
    expect(src).toContain('return balanceMinorAfterCredit - promoGrantedSinceDebtMinor >= 0;');
  });

  it('zero is covered — the boundary is >= 0, not > 0', () => {
    expect(creditCoversOutstandingDebt(0, 0)).toBe(true);
    expect(creditCoversOutstandingDebt(-1, 0)).toBe(false);
  });
});

describe('INVARIANT: the clear is armed for cash reasons only, and the promo exclusion is a REAL discount (source scan)', () => {
  it('the clear is armed for exactly the two CASH reasons', () => {
    // MOVED in the fix round from `dispatch.ts` to `@balo/shared/credit` so `@balo/analytics` and
    // `@balo/shared/notifications` can DERIVE `CashCreditReason` from the one list instead of
    // restating the union (N9/L5). Same list, same job, new home — scanned at the new home.
    const src = normalize(
      readScannedSourceOrFail(SHARED_PREDICATE_DISPLAY_PATH, SHARED_PREDICATE_URL)
    );
    expect(src).toContain(
      "export const CASH_CREDIT_REASONS = ['manual_purchase', 'auto_topup'] as const;"
    );
    expect(src).toContain('export type CashCreditReason = (typeof CASH_CREDIT_REASONS)[number];');
  });

  it('⚠⚠ B1 — the coverage decision has exactly ONE home, and the raw predicate is called from nowhere else in apps/api', () => {
    // The shipped shape called `creditCoversOutstandingDebt` inline at three sites, each with its
    // own balance source and its own (missing) promo story. Re-inlining ANY of them — the exact
    // regression B1 fixes — fails here: a fourth call, or a call in either app service file,
    // trips one of the three counts below.
    const service = normalize(
      readScannedSourceOrFail(COVERAGE_SERVICE_DISPLAY_PATH, COVERAGE_SERVICE_URL)
    );
    expect(service.match(/creditCoversOutstandingDebt\(/g) ?? []).toHaveLength(1);
    expect(service).toContain(
      'covered: creditCoversOutstandingDebt(balanceMinor, promoGrantedSinceDebtMinor),'
    );

    const dispatch = normalize(readScannedSourceOrFail(DISPATCH_DISPLAY_PATH, DISPATCH_URL));
    expect(dispatch.match(/creditCoversOutstandingDebt\(/g) ?? []).toHaveLength(0);

    const endSession = normalize(
      readScannedSourceOrFail(END_SESSION_DISPLAY_PATH, END_SESSION_URL)
    );
    expect(endSession.match(/creditCoversOutstandingDebt\(/g) ?? []).toHaveLength(0);
  });

  it('⚠⚠ B1 — the discount is PROMO net of EXPIRY, since the debt became outstanding, clamped at zero', () => {
    // A "reason = promo" match that dropped the `entry_type` half, or a discount that summed
    // EVERY adjustment, would over-discount an ops correction and leave real cash uncounted.
    // Widening the window to all time, or narrowing it to `>` the anchor, changes this text.
    //
    // ⚠⚠ FIX ROUND 2 (F2) ADDED THE EXPIRY ARM AND THE CLAMP, and both are pinned here.
    // Summing GRANTS ALONE double-counts a promo the wallet no longer holds: `expireDormantBalance`
    // has already removed that value from `balance_minor` with an `entry_type='expiry'` entry, so
    // subtracting the historical grant a second time refuses a clear the client's own cash paid
    // for — the hold then outlives a paid balance, which is the very thing this file is named
    // after. Deleting the `'expiry'` arm restores that bug and fails here. Deleting the
    // `Math.max(0, …)` clamp lets an expiry that also burned cash drive the discount NEGATIVE,
    // which would LOOSEN the predicate below the no-discount baseline the pure-core rows above
    // pin — also caught here.
    const src = normalize(
      readScannedSourceOrFail(
        'packages/db/src/repositories/credit-ledger.ts',
        new URL('../repositories/credit-ledger.ts', import.meta.url)
      )
    );
    expect(src).toMatch(
      /async sumPromoGrantedSince\(\s*input:\s*\{\s*walletId:\s*string;\s*since:\s*Date\s*\},/
    );
    expect(src).toContain("eq(creditLedger.entryType, 'adjustment')");
    expect(src).toContain("eq(creditLedger.reason, 'promo')");
    expect(src).toContain("eq(creditLedger.entryType, 'expiry')");
    expect(src).toContain('gte(creditLedger.createdAt, input.since)');
    expect(src).toContain('return Math.max(0, Number(row?.sum ?? 0));');
  });

  it("⚠⚠ B1 — the discount window is anchored on the DEBT's moment, never on the receivable row's own opened_at alone", () => {
    // Anchoring on `opened_at` alone is the vacuous case at BOTH R3b sites: the row is inserted
    // in the very transaction that then asks whether it is covered, so the window has zero width
    // and the discount is always zero. Dropping the COALESCE'd `ended_at` fails here.
    //
    // ⚠ FIX ROUND 2 (F1) — the session join is a LEFT JOIN filtered on the session's own
    // `deleted_at`. Unfiltered, a soft-deleted session's older `ended_at` still entered the MIN,
    // widening the window and refusing a covering credit. The filter must stay in the JOIN
    // condition: moved to the `WHERE` over an INNER join it would drop the receivable from the
    // aggregate entirely, and since `hasOpenReceivable` never joins sessions that row would hold
    // the company with no covering credit able to reach it. Both halves are pinned.
    const src = normalize(
      readScannedSourceOrFail(
        'packages/db/src/repositories/credit-receivables.ts',
        new URL('../repositories/credit-receivables.ts', import.meta.url)
      )
    );
    expect(src).toContain(
      'min(coalesce(${creditSessions.endedAt}, ${creditReceivables.openedAt}))'
    );
    // Regex over the whitespace-normalised source — it pins the JOIN SHAPE, not its line breaks.
    expect(src).toMatch(
      /\.leftJoin\(\s*creditSessions,\s*and\(\s*eq\(creditReceivables\.sessionId, creditSessions\.id\),\s*isNull\(creditSessions\.deletedAt\)\s*\)\s*\)/
    );
  });

  it('all THREE hold-releasing sites route through the one coverage module (R3 + both R3b)', () => {
    // R3 asks directly; both R3b sites go through `clearLateOpenedReceivableIfCovered`, which
    // asks on their behalf. A site that stopped importing from here would have to re-derive the
    // discount, which is what B1 exists to prevent — and it fails one of these counts.
    const dispatch = normalize(readScannedSourceOrFail(DISPATCH_DISPLAY_PATH, DISPATCH_URL));
    expect(dispatch).toContain("} from '../credit/receivable-coverage.js';");
    expect(dispatch.match(/assessCashCoverage\(/g) ?? []).toHaveLength(1);
    expect(dispatch.match(/clearLateOpenedReceivableIfCovered\(/g) ?? []).toHaveLength(1);

    const endSession = normalize(
      readScannedSourceOrFail(END_SESSION_DISPLAY_PATH, END_SESSION_URL)
    );
    expect(endSession).toContain(
      "import { clearLateOpenedReceivableIfCovered } from '../credit/receivable-coverage.js';"
    );
    expect(endSession.match(/clearLateOpenedReceivableIfCovered\(/g) ?? []).toHaveLength(1);
  });

  it("the clear rides the caller's txn — never a bare `db`", () => {
    // Regex, not `toContain`, over the whitespace-normalised source: `normalize` collapses every
    // run of whitespace to ONE space, but whether Prettier wraps this call across lines (adding a
    // space after `(` / before `)`) or keeps it on one is a formatting detail this assertion must
    // survive — it pins the CALL SHAPE, not its line breaks.
    const src = normalize(readScannedSourceOrFail(DISPATCH_DISPLAY_PATH, DISPATCH_URL));
    expect(src).toMatch(
      /creditReceivablesRepository\.clearOpenForWallet\(\s*\{\s*walletId:\s*effect\.walletId\s*\}\s*,\s*tx\s*\)/
    );
    expect(src.match(/clearOpenForWallet\(/g) ?? []).toHaveLength(1);
  });
});

describe('INVARIANT: both late-open (R3b) transactions serialise against the credit path (fix round M2)', () => {
  /**
   * Neither R3b site posts a ledger entry, so neither inherited `applyLedgerEntry`'s
   * `acquireWalletLock`. Without an explicit lock the interleaving is real: T1 inserts the
   * receivable (uncommitted) → T2 credits the wallet and finds zero open rows to clear → T1's
   * fresh wallet read still sees the pre-credit negative balance → T1 commits an open receivable
   * plus dunning against a company that has paid in full. Deleting either lock fails here.
   */
  it("end-session.ts's openReceivableAndDun locks the wallet as the FIRST statement of its txn", () => {
    const raw = readScannedSourceOrFail(END_SESSION_DISPLAY_PATH, END_SESSION_URL);
    const body = sliceFunctionBody(raw, 'async function openReceivableAndDun(');
    const txnIdx = body.indexOf('db.transaction(async (tx) =>');
    const lockIdx = body.indexOf('acquireWalletLock(tx, session.walletId)');
    const markIdx = body.indexOf('markSettlementResult');
    const openIdx = body.indexOf('creditReceivablesRepository.open(');
    expect(txnIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(txnIdx);
    // FIRST — before the session stamp and before the receivable insert.
    expect(markIdx).toBeGreaterThan(lockIdx);
    expect(openIdx).toBeGreaterThan(lockIdx);
  });

  it("dispatch.ts's handleOverdraftChargeFailed locks the wallet before it writes anything", () => {
    const raw = readScannedSourceOrFail(DISPATCH_DISPLAY_PATH, DISPATCH_URL);
    const body = sliceFunctionBody(raw, 'async function handleOverdraftChargeFailed(');
    const lockIdx = body.indexOf('acquireWalletLock(tx, session.walletId)');
    const markIdx = body.indexOf('markSettlementResult');
    const openIdx = body.indexOf('creditReceivablesRepository.open(');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(lockIdx);
    expect(openIdx).toBeGreaterThan(lockIdx);
  });

  it('there is exactly ONE advisory-lock class in the whole data layer, so no lock-ordering cycle can exist', () => {
    // The deadlock-freedom argument in both docblocks rests on this: one lock, one key per
    // wallet, taken before any row is touched. A second advisory lock landing ANYWHERE in the
    // repositories would invalidate it and needs its own ordering analysis — so this scans the
    // whole directory, not just the helper. Comments are stripped, so the several docblocks that
    // reference the lock by name neither break this nor satisfy it.
    const helper = normalize(
      codeOnly(
        readScannedSourceOrFail(
          'packages/db/src/repositories/_shared/wallet-lock.ts',
          new URL('../repositories/_shared/wallet-lock.ts', import.meta.url)
        )
      )
    );
    expect(helper.match(/pg_advisory/g) ?? []).toHaveLength(1);
    expect(helper).toContain('SELECT pg_advisory_xact_lock(hashtextextended(${walletId}, 0))');

    // …and NO other repository issues one directly.
    const repoDir = fileURLToPath(new URL('../repositories/', import.meta.url));
    const others = listTsFilesRecursive(repoDir).filter(
      (abs) => !abs.endsWith(`_shared${sep}wallet-lock.ts`)
    );
    expect(others.length).toBeGreaterThan(0);
    const offenders = others.filter((abs) =>
      codeOnly(readFileSync(abs, 'utf8')).includes('pg_advisory')
    );
    expect(offenders.map((abs) => abs.slice(repoDir.length))).toEqual([]);
  });
});

/** Slice raw (non-normalised) source between a start marker and the next top-level function. */
function sliceFunctionBody(raw: string, startMarker: string): string {
  const start = raw.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Marker not found: "${startMarker}"`);
  }
  const nextFnIdx = raw.indexOf('\nasync function', start + startMarker.length);
  const end = nextFnIdx === -1 ? raw.length : nextFnIdx;
  return raw.slice(start, end);
}

describe('INVARIANT: the one-per-session receivable unique stays STATUS-BLIND (schema source scan)', () => {
  it('⚠⚠ the unique is status-blind, and must stay that way — a cleared row can never be re-opened', () => {
    const src = normalize(
      readScannedSourceOrFail(
        'packages/db/src/schema/credit-receivables.ts',
        new URL('../schema/credit-receivables.ts', import.meta.url)
      )
    );
    expect(src).toContain(
      "uniqueIndex('credit_receivables_session_uidx') .on(t.sessionId) .where(sql`${t.deletedAt} IS NULL`)"
    );
    // A future "improvement" to `WHERE status = 'open'` would let a late `payment_failed` for an
    // already-cleared session re-open the hold. Fail HERE, by name, if that ever lands.
    //
    // ⚠ FIX ROUND N1 — a THIRD assertion used to sit here:
    //     expect(src).not.toContain("credit_receivables_session_uidx').on(t.sessionId).where(sql`${t.status}")
    //   It was DEAD and is deleted, not repaired. `src` is whitespace-NORMALISED and Prettier
    //   wraps that builder chain across lines, so the normalised text ALWAYS has spaces between
    //   `.on(` and `.where(` — the literal it searched for could never appear, mutation or no
    //   mutation. Re-adding it as a spaced variant would only duplicate the regex below, which
    //   already catches the mutation (it matches `status` anywhere between the index name and the
    //   next `;`, whatever the wrapping).
    expect(src).not.toMatch(/credit_receivables_session_uidx'\)[^;]*status/);
  });

  it('the scope dependency this design leans on — ONE wallet per company — stays visible, not assumed', () => {
    // §4(a) — clearing is by walletId, the tighter of the two scopes. It stays correct only
    // because `credit_wallets_company_idx` is a UNIQUE index today; if a future multi-wallet
    // company ever lands, THIS assertion fails by name and forces a fresh decision about the
    // hold's scope, rather than silently clearing the wrong wallet's receivables.
    const src = normalize(
      readScannedSourceOrFail(
        'packages/db/src/schema/credit-wallets.ts',
        new URL('../schema/credit-wallets.ts', import.meta.url)
      )
    );
    expect(src).toContain("uniqueIndex('credit_wallets_company_idx').on(t.companyId)");
  });
});

describe('INVARIANT: an open receivable never coexists with a `processing` settlement (§G.1)', () => {
  it("⚠⚠ end-session.ts's openReceivableAndDun marks the session terminal in the SAME txn it opens the receivable in", () => {
    const raw = readScannedSourceOrFail(END_SESSION_DISPLAY_PATH, END_SESSION_URL);
    const body = sliceFunctionBody(raw, 'async function openReceivableAndDun(');
    expect(body).toContain('db.transaction(async (tx) =>');
    expect(body).toContain('markSettlementResult');
    expect(body).toContain('creditReceivablesRepository.open(');
    // Ordering — the terminal stamp happens before the receivable opens, inside the one txn.
    const txnIdx = body.indexOf('db.transaction(async (tx) =>');
    const markIdx = body.indexOf('markSettlementResult');
    const openIdx = body.indexOf('creditReceivablesRepository.open(');
    expect(txnIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(txnIdx);
    expect(openIdx).toBeGreaterThan(markIdx);
  });

  it("⚠⚠ dispatch.ts's handleOverdraftChargeFailed marks 'failed' BEFORE it opens the receivable", () => {
    const raw = readScannedSourceOrFail(DISPATCH_DISPLAY_PATH, DISPATCH_URL);
    const body = sliceFunctionBody(raw, 'async function handleOverdraftChargeFailed(');
    const failedIdx = body.indexOf("status: 'failed'");
    const openIdx = body.indexOf('creditReceivablesRepository.open(');
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(failedIdx);
  });

  it("and neither settlement site can mark 'processing' a second time (end-session.ts) — pinning the ONE legitimate stamp inside settleOverdraft's success arm", () => {
    const endSession = readScannedSourceOrFail(END_SESSION_DISPLAY_PATH, END_SESSION_URL);
    expect(endSession.match(/status: 'processing'/g) ?? []).toHaveLength(1);
  });

  it('the presence settlement service stamps no processing status at all', () => {
    const settleFromPresence = readScannedSourceOrFail(
      'apps/api/src/services/credit-session/settle-from-presence.ts',
      new URL(
        '../../../../apps/api/src/services/credit-session/settle-from-presence.ts',
        import.meta.url
      )
    );
    expect(settleFromPresence.match(/status: 'processing'/g) ?? []).toHaveLength(0);
  });
});
