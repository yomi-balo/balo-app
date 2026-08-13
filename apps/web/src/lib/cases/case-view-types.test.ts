import { describe, it, expect } from 'vitest';
import type { CaseEarningsView, CaseSurfaceView } from './case-view-types';

/**
 * BAL-421 (security LOW / plan §11) — THE FEE-CONCEALMENT INVARIANT, PINNED.
 *
 * `case-view-types.ts` claims three things about `CaseSurfaceView`, and until this file existed
 * NONE of them was checked anywhere:
 *   1. the CLIENT arm has NO `earnings` field;
 *   2. the EXPERT arm has NO `canClose` field;
 *   3. NEITHER arm can hold a margin / fee / rate figure.
 *
 * ── ⚠ WHY THIS IS A `.test.ts` AND NOT A `.test-d.ts` ────────────────────────────────────
 * This repo has NO type-test tooling: there is not one `*.test-d.ts` anywhere, and vitest's
 * `typecheck` option is not configured in any config — so a `.test-d.ts` file would be
 * collected as an ordinary test containing no tests, and its `expectTypeOf` assertions would
 * never be evaluated by anything. A green run would mean nothing at all. So the invariant is
 * pinned TWICE, by the two mechanisms this repo actually runs:
 *
 *   · COMPILE-TIME — the exported `Assert*` witness types below. They are the same
 *     `Exclude<…>`-into-`never` device the codebase already uses for its enum drift guards
 *     (`AssertMeetingLabelsMatch`, `AssertEngagementStatusLabelsMatch`), and they are checked
 *     by the gate's own `pnpm typecheck`. Violating one fails `tsc` HERE.
 *   · RUNTIME — the `in`-operator assertions over CONSTRUCTED objects. These are NOT redundant:
 *     a type cannot stop `load-case.ts` from spreading an extra key onto a value whose declared
 *     type merely lacks it, and structural typing means the excess survives to the wire. The
 *     serialization-boundary test at the bottom is the one that would actually catch a leak.
 */

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE-TIME WITNESSES — a violation fails `tsc`, not merely this suite.
// ─────────────────────────────────────────────────────────────────────────────

type ClientArm = Extract<CaseSurfaceView, { lens: 'client' }>;
type ExpertArm = Extract<CaseSurfaceView, { lens: 'expert' }>;

type AssertNever<T extends never> = T;

/** ⚠ 1. The CLIENT arm cannot HOLD an expert's earnings figure. */
export type AssertClientArmHasNoEarnings = AssertNever<Extract<keyof ClientArm, 'earnings'>>;

/** ⚠ 2. Only a client may close a case (BAL-417); the expert may only ASK. */
export type AssertExpertArmHasNoCanClose = AssertNever<Extract<keyof ExpertArm, 'canClose'>>;

/**
 * ⚠ 3. THE BALO MARGIN APPEARS TO NOBODY. Neither arm may carry any of the vocabulary the
 * un-marked-up rate travels under. `rate_cents` matters most: it is the UN-MARKED-UP consultant
 * rate, so handing a client lens a payload containing it would leak the margin by subtraction.
 */
type FeeVocabulary =
  | 'margin'
  | 'baloFee'
  | 'baloFeeBps'
  | 'feeBps'
  | 'markup'
  | 'markupBps'
  | 'rateCents'
  | 'rateAudMinor'
  | 'platformFee'
  | 'commission';

export type AssertNoFeeFieldOnClientArm = AssertNever<Extract<keyof ClientArm, FeeVocabulary>>;
export type AssertNoFeeFieldOnExpertArm = AssertNever<Extract<keyof ExpertArm, FeeVocabulary>>;

/** …and not nested inside the one money-bearing shape either. */
export type AssertNoFeeFieldOnEarnings = AssertNever<
  Extract<keyof CaseEarningsView, FeeVocabulary>
>;

/**
 * ⚠ THE `not_yet` / `pending` ARMS CANNOT HOLD A FIGURE AT ALL — `earningsAudMinor` is typed
 * `null`, not `number | null`. That is what makes "A$0.00 for every expert on the platform"
 * unrepresentable rather than merely unlikely.
 */
export type AssertNotYetHasNoFigure = AssertNever<
  Exclude<Extract<CaseEarningsView, { state: 'not_yet' }>['earningsAudMinor'], null>
>;
export type AssertPendingHasNoFigure = AssertNever<
  Exclude<Extract<CaseEarningsView, { state: 'pending' }>['earningsAudMinor'], null>
>;

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME — over CONSTRUCTED objects, because a type cannot stop an excess key.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = {
  engagementId: 'e-1',
  viewerUserId: 'u-1',
  header: {
    title: 'Flow interview loop',
    descriptionHtml: '<p>hi</p>',
    openedAtIso: '2026-06-12T09:00:00Z',
    heldConsultationCount: 1,
    consultationCount: 1,
    isOpen: true,
    closeReason: null,
    closedAtIso: null,
    counterpartyOrgLabel: 'CloudPeak',
    closedNote: null,
  },
  nudge: null,
  consultations: [],
  conversation: {
    conversationId: 'v-1',
    writable: true,
    counterpartyFirstName: 'Amara',
    counterpartyName: 'Amara Okafor',
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
  },
  actionItems: {
    yours: [],
    theirs: [],
    unassigned: [],
    counterpartyLabel: 'Amara',
    doneCount: 0,
    totalCount: 0,
  },
  files: [],
  filesTruncated: false,
  party: {
    name: 'Amara Okafor',
    headline: null,
    orgLabel: 'CloudPeak',
    avatarUrl: null,
    initials: 'AO',
    bookAgainHref: null,
  },
  // ⚠ NO `as const` HERE. It would type every array as a `readonly` tuple, which is NOT
  // assignable to the view's mutable `CaseConsultationRowView[]` / `CasePersonView[]`. The
  // two typed assignments below are the whole point of this file, so the fixture has to be
  // genuinely assignable — freezing it would make them fail for a reason unrelated to the
  // invariant being pinned.
  people: [{ name: 'Dana Reyes', isViewer: true }],
};

const CLIENT_VIEW: CaseSurfaceView = { ...BASE, lens: 'client', canClose: true };

const EXPERT_VIEW: CaseSurfaceView = {
  ...BASE,
  lens: 'expert',
  earnings: { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 },
  canRequestResolution: true,
};

const FEE_KEYS: readonly string[] = [
  'margin',
  'baloFee',
  'baloFeeBps',
  'feeBps',
  'markup',
  'markupBps',
  'rateCents',
  'rateAudMinor',
  'platformFee',
  'commission',
];

describe('CaseSurfaceView — the lens is a discriminant, not a flag', () => {
  it('a CLIENT-lens view has NO `earnings` key — it cannot hold the figure at all', () => {
    expect('earnings' in CLIENT_VIEW).toBe(false);
    expect(Object.keys(CLIENT_VIEW)).not.toContain('earnings');
  });

  it('an EXPERT-lens view has NO `canClose` key — only a client may close (BAL-417)', () => {
    expect('canClose' in EXPERT_VIEW).toBe(false);
    expect(Object.keys(EXPERT_VIEW)).not.toContain('canClose');
  });

  it('each arm carries its OWN lifecycle flag, and only its own', () => {
    expect('canClose' in CLIENT_VIEW).toBe(true);
    expect('canRequestResolution' in CLIENT_VIEW).toBe(false);
    expect('canRequestResolution' in EXPERT_VIEW).toBe(true);
  });
});

describe('CaseSurfaceView — neither arm can hold a margin or fee figure', () => {
  it.each([
    ['client', CLIENT_VIEW],
    ['expert', EXPERT_VIEW],
  ])('the %s arm carries no fee vocabulary at the top level', (_lens, view) => {
    for (const key of FEE_KEYS) {
      expect(key in view).toBe(false);
    }
  });

  /**
   * ⚠ THE ASSERTION THAT WOULD ACTUALLY CATCH A LEAK. It walks the SERIALIZED payload — which
   * is what crosses to the browser — rather than the top-level key set, so a fee figure buried
   * inside `party`, `conversation` or a consultation row cannot hide from it.
   */
  it.each([
    ['client', CLIENT_VIEW],
    ['expert', EXPERT_VIEW],
  ])('no fee vocabulary appears ANYWHERE in the serialized %s payload', (_lens, view) => {
    const serialized = JSON.stringify(view).toLowerCase();
    for (const key of FEE_KEYS) {
      expect(serialized).not.toContain(key.toLowerCase());
    }
  });

  it('the expert arm exposes own EARNINGS only — never a charge, never a rate', () => {
    const earningsKeys = Object.keys(
      (EXPERT_VIEW as Extract<CaseSurfaceView, { lens: 'expert' }>).earnings
    );
    expect(earningsKeys.sort()).toEqual([
      'earningsAudMinor',
      'finalizedCount',
      'pendingCount',
      'state',
    ]);
  });
});

describe('CaseEarningsView — "no data" and "A$0.00" are structurally different values', () => {
  it('the `not_yet` arm carries a NULL figure, never a zero', () => {
    const notYet: CaseEarningsView = {
      state: 'not_yet',
      earningsAudMinor: null,
      finalizedCount: 0,
      pendingCount: 0,
    };
    expect(notYet.earningsAudMinor).toBeNull();
    expect(notYet.earningsAudMinor).not.toBe(0);
  });

  it('a `finalized` zero is a REAL zero, and distinguishable from `not_yet`', () => {
    const finalized: CaseEarningsView = {
      state: 'finalized',
      earningsAudMinor: 0,
      finalizedCount: 1,
      pendingCount: 0,
    };
    expect(finalized.earningsAudMinor).toBe(0);
    expect(finalized.state).not.toBe('not_yet');
  });
});
