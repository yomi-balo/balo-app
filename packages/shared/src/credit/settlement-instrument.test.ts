import { describe, it, expect } from 'vitest';
import {
  resolveSettlementInstrument,
  type SettlementInstrumentCandidates,
  type ResolvedSettlementInstrument,
} from './settlement-instrument';

/**
 * BAL-525 (ADR-1040 Amendment 5) — dedicated unit coverage for the pure resolver. This is
 * ADDITIVE to, not a replacement for,
 * `packages/db/src/invariants/session-debt-carries-its-collection-instrument.test.ts`, which pins
 * the cross-cutting INVARIANT (schema + repository wiring + `settleOverdraft`'s use of this
 * function) and the anti-collapse shape. This file exists so the function itself has in-package
 * coverage rather than only the transitive kind the invariant suite provides — the classic
 * SonarCloud new-code coverage miss on a whole new file with no sibling test.
 *
 * Style follows the neighbouring `card-reuse.test.ts` / `money-block.test.ts`: a labeled table run
 * with `it.each`, plus targeted assertions for the branches a table alone can't name.
 */

const CUS_1 = 'cus_1';
const CUS_OLD = 'cus_old';
const CUS_NEW = 'cus_new';
const PM_1 = 'pm_1';
const PM_OLD = 'pm_old';
const PM_NEW = 'pm_new';

interface Row {
  label: string;
  candidates: SettlementInstrumentCandidates;
  expected: ResolvedSettlementInstrument;
}

const ROWS: readonly Row[] = [
  {
    label: 'no pin at all (both ids null) — resolves to the live pair',
    candidates: {
      pinned: { customerId: null, paymentMethodId: null },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
  {
    label: 'half-set pin — customer present, payment method missing — resolves to the live pair',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: null },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
  {
    label: 'half-set pin — payment method present, customer missing — resolves to the live pair',
    candidates: {
      pinned: { customerId: null, paymentMethodId: PM_1 },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
  {
    label: 'complete pin, matches the live pair exactly — resolves to the PIN, no disagreement',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: PM_1 },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'pinned', pinDisagrees: false },
  },
  {
    label: 'complete pin — payment method alone differs — resolves to LIVE, disagreement flagged',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: PM_OLD },
      live: { customerId: CUS_1, paymentMethodId: PM_NEW },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_NEW, source: 'wallet', pinDisagrees: true },
  },
  {
    label: 'complete pin — customer alone differs — resolves to LIVE, disagreement flagged',
    candidates: {
      pinned: { customerId: CUS_OLD, paymentMethodId: PM_1 },
      live: { customerId: CUS_NEW, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_NEW, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: true },
  },
  {
    label: 'complete pin — both ids differ — resolves to LIVE, disagreement flagged',
    candidates: {
      pinned: { customerId: CUS_OLD, paymentMethodId: PM_OLD },
      live: { customerId: CUS_NEW, paymentMethodId: PM_NEW },
    },
    expected: {
      customerId: CUS_NEW,
      paymentMethodId: PM_NEW,
      source: 'wallet',
      pinDisagrees: true,
    },
  },
];

describe('resolveSettlementInstrument', () => {
  it.each(ROWS)('$label', ({ candidates, expected }) => {
    expect(resolveSettlementInstrument(candidates)).toEqual(expected);
  });

  it('never mutates its inputs', () => {
    const candidates: SettlementInstrumentCandidates = {
      pinned: { customerId: CUS_OLD, paymentMethodId: PM_OLD },
      live: { customerId: CUS_NEW, paymentMethodId: PM_NEW },
    };
    const snapshot = JSON.parse(JSON.stringify(candidates)) as SettlementInstrumentCandidates;
    resolveSettlementInstrument(candidates);
    expect(candidates).toEqual(snapshot);
  });

  it('the returned object carries exactly the four documented fields — no leaked internals', () => {
    const resolved = resolveSettlementInstrument({
      pinned: { customerId: CUS_1, paymentMethodId: PM_1 },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    });
    expect(Object.keys(resolved).sort()).toEqual(
      ['customerId', 'paymentMethodId', 'source', 'pinDisagrees'].sort()
    );
  });

  it('a disagreeing pin never leaks into the resolved pair — the ids are always the LIVE ones', () => {
    const resolved = resolveSettlementInstrument({
      pinned: { customerId: CUS_OLD, paymentMethodId: PM_OLD },
      live: { customerId: CUS_NEW, paymentMethodId: PM_NEW },
    });
    expect(resolved.customerId).not.toBe(CUS_OLD);
    expect(resolved.paymentMethodId).not.toBe(PM_OLD);
    expect(resolved).toMatchObject({ customerId: CUS_NEW, paymentMethodId: PM_NEW });
  });
});
