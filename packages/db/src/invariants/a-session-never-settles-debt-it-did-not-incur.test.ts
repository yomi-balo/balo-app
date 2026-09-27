import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSessionOverdraftShare } from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — A SESSION NEVER SETTLES DEBT IT DID NOT INCUR. ADR-1040 Amendment 7 §A
 * (BAL-474, orchestrator rulings D1 / D5.1 / D7.3).
 *
 * At a session's terminal settlement the figure charged (or put to a receivable) is THIS
 * session's share of the wallet's negative balance:
 *
 *   share = min(ownConsumed, max(0, −walletBalance))
 *
 * where `ownConsumed` is the gross `session_consume` the session itself posted. Before BAL-474 the
 * figure was the WHOLE wallet's negative balance (`max(0, −balance)`), which was safe only because
 * the gated `open()` refused to start a session onto a negative wallet, an open receivable, or an
 * in-flight settlement. Amendment 7's overdraft-tolerant open lifts those gates on the presence
 * seam, so the arithmetic itself must now refuse to re-bill older debt: a prior receivable, or
 * another session's in-flight charge.
 *
 * ⚠ THIS FILE CREATES THE INVARIANT. Per ADR-1032 it was AUTHORED AND RUN RED before
 * `resolveSessionOverdraftShare` (`packages/shared/src/credit/session-overdraft-share.ts`) and the
 * two terminal writers' `readSessionOverdraftShare` existed.
 *
 * Two independent claims, each failing by name:
 *  1. The pure core: the share is capped by what the session consumed AND by what the wallet
 *     owes, and it equals the legacy whole-wallet figure on every state the GATED open can reach
 *     (so no shipped settlement changes).
 *  2. The settled overdraft has exactly ONE definition and TWO writers (`end`, the extracted
 *     `settleFromPresenceInTx`), each of which also runs the ownerless-debt check (D7.3).
 */

function readScannedSourceOrFail(displayPath: string, url: URL): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-474 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        'a-session-never-settles-debt-it-did-not-incur.test.ts rather than letting the scan ' +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

/**
 * CODE ONLY — block and line comments removed, so a docblock quoting the call form (the plan
 * notes the docblocks DO quote `readSessionOverdraftShare(`) can neither break nor satisfy a
 * count. Both patterns use a lazy body bounded by their own delimiters (SonarCloud S5852).
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every non-test `.ts` file under `dir`, recursively. */
function listNonTestTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return listNonTestTsFiles(abs);
    if (!entry.isFile() || !abs.endsWith('.ts')) return [];
    return abs.endsWith('.test.ts') ? [] : [abs];
  });
}

const CREDIT_SESSIONS_DISPLAY_PATH = 'packages/db/src/repositories/credit-sessions.ts';
const CREDIT_SESSIONS_URL = new URL('../repositories/credit-sessions.ts', import.meta.url);
const API_SRC_URL = new URL('../../../../apps/api/src/', import.meta.url);

interface Row {
  label: string;
  walletBalanceMinor: number;
  ownConsumedMinor: number;
  overdraftMinor: number;
  priorDebtLeftMinor: number;
}

const ROWS: readonly Row[] = [
  {
    label: 'in credit',
    walletBalanceMinor: 500,
    ownConsumedMinor: 1_000,
    overdraftMinor: 0,
    priorDebtLeftMinor: 0,
  },
  {
    label: 'exactly zero',
    walletBalanceMinor: 0,
    ownConsumedMinor: 1_000,
    overdraftMinor: 0,
    priorDebtLeftMinor: 0,
  },
  {
    label: 'a clean overrun — the legacy figure',
    walletBalanceMinor: -400,
    ownConsumedMinor: 1_000,
    overdraftMinor: 400,
    priorDebtLeftMinor: 0,
  },
  {
    label: 'an empty wallet',
    walletBalanceMinor: -1_000,
    ownConsumedMinor: 1_000,
    overdraftMinor: 1_000,
    priorDebtLeftMinor: 0,
  },
  {
    label: '⚠ WE1 — a prior receivable is NOT re-billed',
    walletBalanceMinor: -27_500,
    ownConsumedMinor: 17_500,
    overdraftMinor: 17_500,
    priorDebtLeftMinor: 10_000,
  },
  {
    label: '⚠ WE2(b) — an in-flight settlement is NOT re-billed (the cap)',
    walletBalanceMinor: -20_000,
    ownConsumedMinor: 14_000,
    overdraftMinor: 14_000,
    priorDebtLeftMinor: 6_000,
  },
  {
    label: '⚠ WE2(d) — a credited-but-still-processing row changes nothing',
    walletBalanceMinor: -14_000,
    ownConsumedMinor: 14_000,
    overdraftMinor: 14_000,
    priorDebtLeftMinor: 0,
  },
  {
    label: '⚠ WE4(a) — a top-up paid the prior debt first',
    walletBalanceMinor: -3_500,
    ownConsumedMinor: 10_500,
    overdraftMinor: 3_500,
    priorDebtLeftMinor: 0,
  },
  {
    label: '⚠ WE3(a) — promo funded part of the session',
    walletBalanceMinor: -11_000,
    ownConsumedMinor: 14_000,
    overdraftMinor: 11_000,
    priorDebtLeftMinor: 0,
  },
  {
    label: '⚠ dormancy expiry zeroed a positive balance before the first tick',
    walletBalanceMinor: -7_000,
    ownConsumedMinor: 7_000,
    overdraftMinor: 7_000,
    priorDebtLeftMinor: 0,
  },
];

/** −50,000 … +500 in 500-minor steps: every negative magnitude the worked examples reach. */
const BALANCE_GRID: readonly number[] = Array.from(
  { length: (50_000 + 500) / 500 + 1 },
  (_, index) => -50_000 + index * 500
);
const OWN_GRID: readonly number[] = [0, 700, 10_500, 17_500];

describe('INVARIANT: a session never settles debt it did not incur — pure core (resolveSessionOverdraftShare)', () => {
  it.each(ROWS)(
    '$label',
    ({ walletBalanceMinor, ownConsumedMinor, overdraftMinor, priorDebtLeftMinor }) => {
      const share = resolveSessionOverdraftShare({ walletBalanceMinor, ownConsumedMinor });
      expect(share.overdraftMinor).toBe(overdraftMinor);
      expect(share.priorDebtLeftMinor).toBe(priorDebtLeftMinor);
      // The two figures the share is composed from are reported as given, never re-derived
      // somewhere else from a second read.
      expect(share.walletNegativeMinor).toBe(Math.max(0, -walletBalanceMinor));
      expect(share.ownConsumedMinor).toBe(ownConsumedMinor);
    }
  );

  it('⚠⚠ ANTI-COLLAPSE #1 — never more than the session consumed', () => {
    // A legacy `max(0, −balance)` implementation fails HERE on every row where the wallet owes
    // more than this session drew — the WE1 / WE2(b) re-billing shape — named, not counted.
    const overBilled: string[] = [];
    for (const walletBalanceMinor of BALANCE_GRID) {
      for (const ownConsumedMinor of OWN_GRID) {
        const share = resolveSessionOverdraftShare({ walletBalanceMinor, ownConsumedMinor });
        if (share.overdraftMinor > ownConsumedMinor) {
          overBilled.push(`balance ${walletBalanceMinor}, own ${ownConsumedMinor}`);
        }
      }
    }
    expect(overBilled).toEqual([]);
    // Positive control: the grid DOES contain states where the wallet owes more than the
    // session drew, so the check above cannot pass vacuously.
    const rowsWithOlderDebt = BALANCE_GRID.flatMap((balance) =>
      OWN_GRID.filter((own) => -balance > own)
    );
    expect(rowsWithOlderDebt.length).toBeGreaterThan(0);
  });

  it('⚠⚠ ANTI-COLLAPSE #2 — never more than the wallet owes', () => {
    const overBilled: string[] = [];
    for (const walletBalanceMinor of BALANCE_GRID) {
      for (const ownConsumedMinor of OWN_GRID) {
        const share = resolveSessionOverdraftShare({ walletBalanceMinor, ownConsumedMinor });
        if (share.overdraftMinor > Math.max(0, -walletBalanceMinor)) {
          overBilled.push(`balance ${walletBalanceMinor}, own ${ownConsumedMinor}`);
        }
        expect(share.overdraftMinor).toBeGreaterThanOrEqual(0);
      }
    }
    expect(overBilled).toEqual([]);
  });

  it('⚠⚠ ANTI-COLLAPSE #3 — identical to the legacy whole-wallet figure on every state the GATED open can reach', () => {
    // The gated open admits only `balanceAtOpen >= 0` and no in-flight settlement. During the
    // session the only debit that is not S's own is `dormancy_expiry`, which zeroes a POSITIVE
    // balance and cannot fire once the session has ticked (every ledger write rolls
    // `expires_at` forward). Credits (a top-up, a promo) only raise the balance. So on every
    // reachable state `−balance ≤ own`, and the share MUST equal `max(0, −balance)` — every
    // shipped settlement is unchanged.
    const states = [0, 700, 5_000].flatMap((balanceAtOpen) =>
      [0, 2_000].flatMap((credits) =>
        [false, true].flatMap((expiredBeforeFirstTick) =>
          [0, 700, 7_000, 14_000].map((ownConsumedMinor) => ({
            label: `open ${balanceAtOpen}, credits ${credits}, expired ${String(expiredBeforeFirstTick)}, own ${ownConsumedMinor}`,
            walletBalanceMinor:
              (expiredBeforeFirstTick ? 0 : balanceAtOpen) + credits - ownConsumedMinor,
            ownConsumedMinor,
          }))
        )
      )
    );
    const diverged = states
      .map((state) => ({
        ...state,
        share: resolveSessionOverdraftShare(state).overdraftMinor,
        legacy: Math.max(0, -state.walletBalanceMinor),
      }))
      .filter((state) => state.share !== state.legacy)
      .map((state) => `${state.label}: ${state.share} vs ${state.legacy}`);
    expect(diverged).toEqual([]);
    expect(states).toHaveLength(48);
  });

  it('rejects non-integer inputs and negative own consumption', () => {
    // Anti-vacuity: the function exists and accepts a well-formed input, so the refusals below
    // are the function's OWN guards — not a TypeError from calling something undefined.
    expect(
      resolveSessionOverdraftShare({ walletBalanceMinor: -100, ownConsumedMinor: 1_000 })
        .overdraftMinor
    ).toBe(100);
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: -100.5, ownConsumedMinor: 1_000 })
    ).toThrow(/integer/);
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: -100, ownConsumedMinor: 10.25 })
    ).toThrow(/integer/);
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: Number.NaN, ownConsumedMinor: 1_000 })
    ).toThrow(/integer/);
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: -100, ownConsumedMinor: -1 })
    ).toThrow(/negative/);
  });
});

describe('INVARIANT: the settled overdraft has exactly one definition and two writers (source scan)', () => {
  it('the legacy whole-wallet ternary is gone from every settlement file', () => {
    // ⚠ Deliberately NOT a bare `-wallet.balanceMinor` scan: `credit-ledger.ts`'s dormancy expiry
    // legitimately contains that expression (it zeroes a positive balance). The FULL legacy
    // ternary — the whole-wallet settlement basis — is what must be gone.
    const LEGACY_TERNARY = /balanceMinor\s*<\s*0\s*\?\s*-\s*wallet\.balanceMinor\s*:\s*0/;

    const repo = codeOnly(
      readScannedSourceOrFail(CREDIT_SESSIONS_DISPLAY_PATH, CREDIT_SESSIONS_URL)
    );
    expect(repo).not.toMatch(LEGACY_TERNARY);

    const apiFiles = listNonTestTsFiles(fileURLToPath(API_SRC_URL));
    // Positive control — the walk found the service tree, so an empty offender list is real.
    expect(apiFiles.length).toBeGreaterThan(0);
    const offenders = apiFiles.filter((abs) =>
      LEGACY_TERNARY.test(codeOnly(readFileSync(abs, 'utf8')))
    );
    expect(offenders).toEqual([]);
  });

  it('both terminal writers route through readSessionOverdraftShare and readOwnerlessPriorDebt, and only they do', () => {
    const repo = codeOnly(
      readScannedSourceOrFail(CREDIT_SESSIONS_DISPLAY_PATH, CREDIT_SESSIONS_URL)
    );
    // 1 definition + 2 calls (`end`, `settleFromPresenceInTx`) for each helper. A third call
    // means a new settlement writer computing its own figure — state where it belongs first.
    expect(repo.match(/readSessionOverdraftShare\(/g) ?? []).toHaveLength(3);
    expect(repo.match(/readOwnerlessPriorDebt\(/g) ?? []).toHaveLength(3);
    // The pure core is reached from exactly ONE place in the repository — the read helper.
    expect(repo.match(/resolveSessionOverdraftShare\(/g) ?? []).toHaveLength(1);
  });
});
