import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isWalletMandateActive,
  walletAllowsOverdraftGrace,
  type OverdraftGraceWalletFields,
} from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — OVERDRAFT GRACE ENTRY REQUIRES AN ACTIVE MANDATE **AND** A CARD-BACKED
 * `low_balance_mode`. A LIVE MANDATE ALONE IS NOT ENOUGH.
 *
 * BAL-523 (ADR-1040 Amendment 4). Follows the named precedent,
 * `expert-paid-for-time-made-available.test.ts`: a pure core from `@balo/shared/credit` pinned
 * for a money rule, plus a source scan resolved via `fileURLToPath(new URL(...,
 * import.meta.url))` — never `process.cwd()`, because CI runs vitest from the repo root
 * (memory `reference_web_server_disk_asset_cwd`).
 *
 * ⚠ THIS FILE CREATES THE INVARIANT; IT DOES NOT AMEND ONE. Before BAL-523 the rule lived in ONE
 * SCHEMA DOCBLOCK ONLY (`packages/db/src/schema/enums.ts`'s `lowBalanceModeEnum`) — "`keep_going`
 * = allow overdraft grace, no reload; `notify_only` = neither" — with nothing executable behind
 * it. The money path read the mandate alone; the mode was never consulted at grace entry. This
 * suite, plus `meterSessionToNow` actually calling `walletAllowsOverdraftGrace` and
 * `applyActiveTick` gating on the flag it snapshots, is what makes the schema's own stated
 * semantics true.
 *
 * ⚠⚠ THE ASYMMETRY IS DELIBERATE AND MUST NOT BE "TIDIED UP". This invariant governs GRACE ENTRY
 * ONLY. Overdraft SETTLEMENT (`settleOverdraft`, `reconcileStuckSettlement`) stays
 * `isWalletMandateActive`-only, forever: entry is the moment Balo takes on NEW collection risk,
 * so it follows the client's CURRENT standing preference; settlement honours a debt already
 * incurred under consent that was live at the time. Gating settlement on the mode too would open
 * a payment-evasion window — enter grace on `keep_going`, flip to `notify_only` mid-session, walk
 * away from consumed time — and would break ADR-1040's "expert always gets paid, with no
 * asterisk". The "settlement is unmoved by the mode" test below is the executable statement of
 * that asymmetry.
 *
 * ⚠⚠ THE `open()` CONNECT GATE IS ALSO OUT OF SCOPE, and that is a REVERSAL, not an oversight
 * (Yomi, 2026-09-04, after the security audit). An earlier BAL-523 revision gated `open()` on
 * this predicate too. It was reverted because `openCaseSessionBestEffort` on the BAL-466
 * admission seam MAY NEVER FAIL A JOIN: a refusal there creates no `credit_sessions` row at all,
 * so the consultation happens, nothing meters, and the expert is unpaid — the exact inversion of
 * ADR-1040 this ticket exists to prevent, widened from "card-less clients" to "anyone who picks
 * Just notify me while underfunded". The source scan below pins `open()` mandate-only.
 */

const CUSTOMER = 'cus_123';
const PAYMENT_METHOD = 'pm_123';
const MODES = ['auto_topup', 'keep_going', 'notify_only'] as const;

/**
 * The 7 card/mandate states `card-reuse.test.ts`'s `TABLE` pins, restated here rather than
 * imported — that file's `Row` shape carries the two OLDER predicates' expected outputs, which
 * are not what this suite is proving.
 */
const WALLET_STATES: ReadonlyArray<{
  label: string;
  wallet: {
    mandateStatus: string | null;
    stripeCustomerId: string | null;
    stripePaymentMethodId: string | null;
  };
}> = [
  {
    label: 'no mandate ever attempted (null) + both ids',
    wallet: {
      mandateStatus: null,
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
  },
  {
    label: "mandate 'pending' + both ids",
    wallet: {
      mandateStatus: 'pending',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
  },
  {
    label: "mandate 'failed' + both ids",
    wallet: {
      mandateStatus: 'failed',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
  },
  {
    label: "mandate 'active' + both ids",
    wallet: {
      mandateStatus: 'active',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
  },
  {
    label: "mandate 'active' but NO customer",
    wallet: {
      mandateStatus: 'active',
      stripeCustomerId: null,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
  },
  {
    label: "mandate 'active' but NO payment method",
    wallet: { mandateStatus: 'active', stripeCustomerId: CUSTOMER, stripePaymentMethodId: null },
  },
  {
    label: 'a brand-new wallet — no status, no ids',
    wallet: { mandateStatus: null, stripeCustomerId: null, stripePaymentMethodId: null },
  },
];

/** The full 7×3 = 21-row table this invariant is proved over. */
const ROWS: ReadonlyArray<{
  label: string;
  mode: (typeof MODES)[number];
  wallet: OverdraftGraceWalletFields;
}> = WALLET_STATES.flatMap(({ label, wallet }) =>
  MODES.map((mode) => ({
    label: `${label} × ${mode}`,
    mode,
    wallet: { ...wallet, lowBalanceMode: mode },
  }))
);

describe('INVARIANT: overdraft grace entry requires an active mandate AND a card-backed low_balance_mode', () => {
  it.each(ROWS)('$label', ({ mode, wallet }) => {
    const expected =
      isWalletMandateActive(wallet) && (mode === 'auto_topup' || mode === 'keep_going');
    expect(walletAllowsOverdraftGrace(wallet)).toBe(expected);
  });

  it('⚠⚠ TWO INDEPENDENT AXES (the anti-collapse assertion) — the mode strips grace from EXACTLY the notify_only rows with an active mandate + both ids, and nothing else', () => {
    // An implementation that "simplifies" to `return isWalletMandateActive(wallet)` collapses
    // this set to empty and fails here, by name — not just by a changed count.
    const strippedByMode = ROWS.filter(
      ({ wallet }) => isWalletMandateActive(wallet) && !walletAllowsOverdraftGrace(wallet)
    );
    expect(strippedByMode.map((row) => row.label)).toEqual([
      "mandate 'active' + both ids × notify_only",
    ]);
  });

  it('⚠ SETTLEMENT IS UNMOVED BY THE MODE — isWalletMandateActive never reads lowBalanceMode', () => {
    for (const { wallet } of WALLET_STATES) {
      const values = MODES.map((mode) => {
        const withMode: OverdraftGraceWalletFields = { ...wallet, lowBalanceMode: mode };
        return isWalletMandateActive(withMode);
      });
      const [first, ...rest] = values;
      if (first === undefined) {
        throw new Error('unreachable — MODES is non-empty');
      }
      for (const value of rest) {
        expect(value).toBe(first);
      }
      // Not just "no variance across modes" — pin it against the wallet's own mandate answer.
      expect(first).toBe(isWalletMandateActive(wallet));
    }
  });

  it('strict narrowing: walletAllowsOverdraftGrace(w) ⇒ isWalletMandateActive(w), and the converse does NOT hold', () => {
    for (const { wallet } of ROWS) {
      if (walletAllowsOverdraftGrace(wallet)) {
        expect(isWalletMandateActive(wallet)).toBe(true);
      }
    }
    // The converse fails on at least one row — proved by name in the anti-collapse test above;
    // restated here as a non-zero count so this test independently fails if that set is ever
    // emptied.
    const converseCounterexamples = ROWS.filter(
      ({ wallet }) => isWalletMandateActive(wallet) && !walletAllowsOverdraftGrace(wallet)
    );
    expect(converseCounterexamples.length).toBeGreaterThan(0);
  });

  it('⚠⚠ FAIL-CLOSED on an unknown future low_balance_mode — proves the allow-list, not `!== notify_only`', () => {
    const wallet: OverdraftGraceWalletFields = {
      mandateStatus: 'active',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
      lowBalanceMode: 'some_future_mode',
    };
    expect(isWalletMandateActive(wallet)).toBe(true);
    expect(walletAllowsOverdraftGrace(wallet)).toBe(false);
  });

  /**
   * ⚠ THE ADR-1032 SEQUENCE. This test is written and run BEFORE the production behaviour
   * change (§11 step 2, before step 3). It WILL FAIL until `credit-sessions.ts` is edited —
   * that failure is expected and correct, not a mistake to "fix" by reordering the plan.
   */
  it('⚠ the production rule is ACTUALLY APPLIED, and settlement was NOT swept up (source scan)', () => {
    const abs = fileURLToPath(new URL('../repositories/credit-sessions.ts', import.meta.url));
    const source = readFileSync(abs, 'utf8');
    // The meter's construction site — the ONE production call — uses the predicate.
    expect(source).toContain('overdraftGraceAllowed: walletAllowsOverdraftGrace(wallet)');
    // The old meter param name is gone.
    expect(source).not.toContain('params.mandateActive');
    // ⚠ EXACTLY ONE. Grace entry is the only site on this predicate. A second occurrence means
    // someone re-gated `open()` (or a settlement path) on the mode — see the ⚠⚠ note in this
    // file's header for why that reversal must not be re-reversed silently.
    //
    // ⚠ R8 — MATCHED ON THE CALL, NOT ON THE ARGUMENT NAME. The literal
    // `walletAllowsOverdraftGrace(wallet)` missed any future call site that spelled its local
    // differently (`…(w)`, `…(settledWallet)`), so a second gate could be added invisibly. The
    // prose mentions in this file's own docblocks carry no `(`, so they do not inflate the count.
    const occurrences = (source.match(/walletAllowsOverdraftGrace\(/g) ?? []).length;
    expect(occurrences).toBe(1);
    // ⚠ The `open()` connect gate stays MANDATE-ONLY (BAL-523 reversal, 2026-09-04).
    expect(source).toContain('const mandateActive = isWalletMandateActive(wallet);');
    expect(source).toContain('if (available < estimateMinor && !mandateActive) {');
    // ⚠⚠ A POSITIVE assertion that ALL FOUR SETTLEMENT-side `mandateActive:` returns were NOT
    // renamed along with the meter. A "consistency" sweep that folds these into
    // `overdraftGraceAllowed` fails HERE, loudly. ⚠ COUNTED, not merely `toContain` — a PARTIAL
    // sweep that converts three of the four (or the `settledWallet` one, which the substring
    // `…(wallet)` never covered at all) would otherwise pass on the survivors.
    expect(
      (source.match(/mandateActive: isWalletMandateActive\(/g) ?? []).length
    ).toBeGreaterThanOrEqual(4);
  });
});
