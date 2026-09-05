import { describe, it, expect } from 'vitest';
import {
  isWalletMandateActive,
  isWalletCardReusableOnSession,
  walletAllowsOverdraftGrace,
  type MandateWalletFields,
  type OverdraftGraceWalletFields,
} from './settlement';

/**
 * The two stored-card predicates, pinned SIDE BY SIDE over one table of wallet states
 * (the `expert-side-visibility.test.ts` pattern). They answer different questions and the
 * difference is a CONSENT BOUNDARY, not an optimisation:
 *
 *   · `isWalletMandateActive`         — may Balo charge this card OFF-SESSION, with nobody
 *                                       watching (auto-top-up, overdraft settlement)? That
 *                                       consent is captured by an explicit off-session
 *                                       SetupIntent, so it REQUIRES `mandate_status='active'`.
 *   · `isWalletCardReusableOnSession` — is there a card we may charge ON-SESSION, with the
 *                                       buyer present and pressing Pay? Only needs the ids.
 *
 * The three rows where they DISAGREE are the whole point of this file: a card saved by a
 * `notify_only` purchase (which never opens a SetupIntent) is reusable on-session while
 * remaining un-chargeable off-session. An "alignment" refactor that collapses one predicate
 * into the other fails here loudly rather than silently widening what Balo may charge unattended.
 */

const CUSTOMER = 'cus_123';
const PAYMENT_METHOD = 'pm_123';

interface Row {
  label: string;
  wallet: MandateWalletFields;
  mandateActive: boolean;
  reusableOnSession: boolean;
}

const TABLE: Row[] = [
  {
    // The saved-card case this whole feature exists for: a `notify_only` buyer's card,
    // persisted by `applySavedCardDisplay`, which NEVER writes `mandate_status`.
    label: 'no mandate ever attempted (null) + both ids',
    wallet: {
      mandateStatus: null,
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
    mandateActive: false,
    reusableOnSession: true,
  },
  {
    label: "mandate 'pending' + both ids",
    wallet: {
      mandateStatus: 'pending',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
    mandateActive: false,
    reusableOnSession: true,
  },
  {
    label: "mandate 'failed' + both ids",
    wallet: {
      mandateStatus: 'failed',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
    mandateActive: false,
    reusableOnSession: true,
  },
  {
    label: "mandate 'active' + both ids",
    wallet: {
      mandateStatus: 'active',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
    mandateActive: true,
    reusableOnSession: true,
  },
  {
    label: "mandate 'active' but NO customer",
    wallet: {
      mandateStatus: 'active',
      stripeCustomerId: null,
      stripePaymentMethodId: PAYMENT_METHOD,
    },
    mandateActive: false,
    reusableOnSession: false,
  },
  {
    label: "mandate 'active' but NO payment method",
    wallet: { mandateStatus: 'active', stripeCustomerId: CUSTOMER, stripePaymentMethodId: null },
    mandateActive: false,
    reusableOnSession: false,
  },
  {
    label: 'a brand-new wallet — no status, no ids',
    wallet: { mandateStatus: null, stripeCustomerId: null, stripePaymentMethodId: null },
    mandateActive: false,
    reusableOnSession: false,
  },
];

describe('stored-card predicates (top-up redesign) — the two are NOT interchangeable', () => {
  it.each(TABLE)(
    '$label → mandateActive=$mandateActive, reusableOnSession=$reusableOnSession',
    ({ wallet, mandateActive, reusableOnSession }) => {
      expect(isWalletMandateActive(wallet)).toBe(mandateActive);
      expect(isWalletCardReusableOnSession(wallet)).toBe(reusableOnSession);
    }
  );

  it('the two predicates genuinely DISAGREE on exactly the three non-active-with-ids states', () => {
    // Not a restatement of the table: this asserts the predicates are not the same function.
    // If someone "aligns" them, this count collapses to 0 and the test fails.
    const disagreements = TABLE.filter(
      (row) => isWalletMandateActive(row.wallet) !== isWalletCardReusableOnSession(row.wallet)
    );
    expect(disagreements.map((row) => row.label)).toEqual([
      'no mandate ever attempted (null) + both ids',
      "mandate 'pending' + both ids",
      "mandate 'failed' + both ids",
    ]);
  });

  it('off-session is strictly NARROWER than on-session — active always implies reusable', () => {
    // The direction that matters for safety: nothing may be charged off-session that could not
    // also be charged on-session. The converse must NOT hold (proved by the disagreements above).
    for (const row of TABLE) {
      if (isWalletMandateActive(row.wallet)) {
        expect(isWalletCardReusableOnSession(row.wallet)).toBe(true);
      }
    }
  });

  it('is unaffected by an unknown future mandate_status string (on-session ignores status)', () => {
    const wallet: MandateWalletFields = {
      mandateStatus: 'some_future_status',
      stripeCustomerId: CUSTOMER,
      stripePaymentMethodId: PAYMENT_METHOD,
    };
    expect(isWalletMandateActive(wallet)).toBe(false);
    expect(isWalletCardReusableOnSession(wallet)).toBe(true);
  });
});

/**
 * BAL-523 — additive only. `TABLE` and its three assertions above are UNTOUCHED: they pin the
 * original two predicates and must keep passing exactly as they did before this ticket.
 *
 * `walletAllowsOverdraftGrace` is a THIRD predicate, not an alignment of the first two — see
 * `settlement.ts`'s docblock. The full cross-product proof (7 card/mandate states × 3 modes,
 * the anti-collapse assertion, the fail-closed-on-unknown-mode assertion) lives in the dedicated
 * invariant suite, `packages/db/src/invariants/overdraft-grace-requires-card-backed-mode.test.ts`
 * — this block only adds the THIRD column to the existing side-by-side table and pins that the
 * mode moves ONLY `walletAllowsOverdraftGrace`, never the other two.
 */
describe('the THIRD predicate: the mode is a SECOND consent axis (BAL-523)', () => {
  const MODES = ['auto_topup', 'keep_going', 'notify_only'] as const;

  interface ModeRow {
    label: string;
    wallet: OverdraftGraceWalletFields;
    mandateActive: boolean;
    reusableOnSession: boolean;
    graceAllowed: boolean;
  }

  const MODE_TABLE: ModeRow[] = TABLE.flatMap((row) =>
    MODES.map((mode) => {
      const wallet: OverdraftGraceWalletFields = { ...row.wallet, lowBalanceMode: mode };
      return {
        label: `${row.label} × ${mode}`,
        wallet,
        mandateActive: row.mandateActive,
        reusableOnSession: row.reusableOnSession,
        graceAllowed: row.mandateActive && (mode === 'auto_topup' || mode === 'keep_going'),
      };
    })
  );

  it.each(MODE_TABLE)(
    '$label → mandateActive=$mandateActive, reusableOnSession=$reusableOnSession, graceAllowed=$graceAllowed',
    ({ wallet, mandateActive, reusableOnSession, graceAllowed }) => {
      expect(isWalletMandateActive(wallet)).toBe(mandateActive);
      expect(isWalletCardReusableOnSession(wallet)).toBe(reusableOnSession);
      expect(walletAllowsOverdraftGrace(wallet)).toBe(graceAllowed);
    }
  );

  it('the mode changes walletAllowsOverdraftGrace and NOTHING ELSE — the other two predicates are identical across all three modes for the same card/mandate state', () => {
    for (const row of TABLE) {
      const perMode = MODES.map((mode) => {
        const withMode: OverdraftGraceWalletFields = { ...row.wallet, lowBalanceMode: mode };
        return {
          mandateActive: isWalletMandateActive(withMode),
          reusableOnSession: isWalletCardReusableOnSession(withMode),
        };
      });
      const [first, ...rest] = perMode;
      if (first === undefined) {
        throw new Error('unreachable — MODES is non-empty');
      }
      for (const value of rest) {
        expect(value).toEqual(first);
      }
    }
  });
});
