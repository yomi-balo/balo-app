import { describe, expect, it } from 'vitest';
import type {
  CasesIndexCaseRow,
  CasesIndexResolvedRow,
  CasesIndexTrailMeeting,
  LiveRescheduleProposalSummary,
} from '@balo/db';
import {
  buildCasesIndexCards,
  buildCasesIndexResolvedRows,
  indexLiveProposals,
  resolveFeaturedEngagementId,
  type CasesIndexCardContext,
} from './build-cases-index-cards';
import {
  CASES_INDEX_CARD_VIEW_KEYS,
  CASES_INDEX_RESOLVED_ROW_VIEW_KEYS,
} from './cases-index-view-types';

/**
 * BAL-567 — the projection from repository rows to the client-safe card views.
 *
 * ⚠⚠ THE KEY-SET AND DENYLIST CASES ARE THE LOAD-BEARING ONES. The builder is the ONLY place a
 * repository row becomes something the browser receives, so this is where "no money, no secrets,
 * no emails" is either true or silently false.
 */

const NOW = new Date('2026-09-16T04:30:00.000Z');
const MIN = 60_000;
const EXPERT_USER_ID = 'user-expert';
const COLLEAGUE_USER_ID = 'user-colleague';
const VIEWER_USER_ID = 'user-viewer';

/**
 * The fixture carries EVERY COLUMN `CasesIndexCaseRow` declares, not only the ones the card
 * happens to read.
 *
 * ⚠⚠ THAT IS ABOUT THE **BUILDER'S OUTPUT**, NOT ABOUT SMUGGLING A DENIED FIELD IN THROUGH THE
 * INPUT — an earlier version of this comment claimed the latter and was wrong. `CasesIndexCaseRow`
 * declares no denied field (`rate_cents`, `join_url`, `email` and friends are structurally absent
 * from the repository's own allow-list), and `Partial<CasesIndexCaseRow>` cannot add one, so no
 * fixture reachable from here could ever carry one INTO the builder.
 *
 * What the key-set and deep-walk cases below actually hold is the one thing that matters: a
 * denied field appearing in what the builder EMITS is caught. That is mutation-proven — adding
 * `rateCents: 33_700` to `buildCard`'s return fails both of them — and it is the direction a leak
 * would really arrive from, since a widened repository projection reaches the browser only by
 * passing through this projection first.
 */
function caseRow(overrides: Partial<CasesIndexCaseRow> = {}): CasesIndexCaseRow {
  return {
    engagementId: 'eng-1',
    title: 'CPQ discount schedule errors',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    resolutionRequestedAt: null,
    resolutionRequestedByUserId: null,
    companyId: 'co-1',
    companyName: 'Acme Corp',
    expertProfileId: 'ep-1',
    expertUserId: EXPERT_USER_ID,
    expertFirstName: 'Marcus',
    expertLastName: 'Lee',
    expertAvatarUrl: 'https://cdn.example/marcus.png',
    expertUsername: 'marcus',
    expertHeadline: 'CPQ specialist',
    expertType: 'agency',
    agencyId: 'ag-1',
    agencyName: 'Stratus Advisory',
    nextBookingAt: new Date(NOW.getTime() + 60 * MIN),
    lastHeldAt: new Date('2026-09-12T00:00:00.000Z'),
    heldCount: 1,
    bucket: 0,
    sortRank: 1,
    ...overrides,
  };
}

function trailMeeting(overrides: Partial<CasesIndexTrailMeeting> = {}): CasesIndexTrailMeeting {
  return {
    meetingId: 'm-1',
    scheduledStart: new Date(NOW.getTime() + 60 * MIN),
    scheduledEnd: new Date(NOW.getTime() + 90 * MIN),
    startedAt: null,
    status: 'scheduled',
    outcome: null,
    roomReady: true,
    ...overrides,
  };
}

function proposal(
  overrides: Partial<LiveRescheduleProposalSummary> = {}
): LiveRescheduleProposalSummary {
  return {
    proposalId: 'p-1',
    meetingId: 'm-1',
    optionCount: 3,
    originalScheduledStart: new Date(NOW.getTime() + 60 * MIN),
    expiresAt: new Date(NOW.getTime() + 24 * 60 * MIN),
    proposedByUserId: EXPERT_USER_ID,
    ...overrides,
  };
}

function context(overrides: Partial<CasesIndexCardContext> = {}): CasesIndexCardContext {
  return {
    side: 'company',
    viewerUserId: VIEWER_USER_ID,
    now: NOW,
    trailByEngagement: new Map([['eng-1', [trailMeeting()]]]),
    tagsByEngagement: new Map([
      [
        'eng-1',
        [
          { productId: 'pr-1', name: 'CPQ' },
          { productId: 'pr-2', name: 'Revenue Cloud' },
        ],
      ],
    ]),
    actionItemsByEngagement: new Map([['eng-1', { client: 2, expert: 5, unassigned: 1 }]]),
    unreadEngagementIds: new Set<string>(),
    proposalByMeetingId: new Map<string, LiveRescheduleProposalSummary>(),
    actorFirstNameById: new Map<string, string | null>(),
    featuredEngagementId: null,
    ...overrides,
  };
}

function firstCard(
  rows: readonly CasesIndexCaseRow[],
  ctx: CasesIndexCardContext
): ReturnType<typeof buildCasesIndexCards>[number] {
  const [card] = buildCasesIndexCards(rows, ctx);
  if (card === undefined) throw new Error('expected a card');
  return card;
}

// ── The boundary ──────────────────────────────────────────────────────────────────────────────

describe('the card DTO’s boundary', () => {
  it('carries EXACTLY the pinned key set, and nothing else', () => {
    const card = firstCard([caseRow()], context());
    expect(Object.keys(card).sort()).toEqual([...CASES_INDEX_CARD_VIEW_KEYS].sort());
    expect(Object.keys(card)).toHaveLength(CASES_INDEX_CARD_VIEW_KEYS.length);
  });

  it('carries EXACTLY the pinned key set on a resolved row too', () => {
    const [row] = buildCasesIndexResolvedRows([resolvedRow()], 'company');
    if (row === undefined) throw new Error('expected a row');
    expect(Object.keys(row).sort()).toEqual([...CASES_INDEX_RESOLVED_ROW_VIEW_KEYS].sort());
    expect(Object.keys(row)).toHaveLength(CASES_INDEX_RESOLVED_ROW_VIEW_KEYS.length);
  });

  /**
   * ⚠⚠ A DEEP KEY WALK, NOT A TOP-LEVEL `Object.keys`. A leaked figure is most likely to arrive
   * nested (inside a booking object, a tag, a trail entry), which a top-level check would miss
   * entirely.
   */
  const DENIED_KEYS = [
    'ratecents',
    'feecents',
    'amountcents',
    'earnings',
    'email',
    'joinurl',
    'dailyroomname',
    'idempotencykey',
    'bookingidempotencykey',
    'balofeebps',
    'stripeconnectid',
    'workosid',
    'declinenote',
  ];

  function deepKeys(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const entry of value) deepKeys(entry, into);
      return into;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        into.push(key);
        deepKeys(nested, into);
      }
    }
    return into;
  }

  it('⚠ guards the guard: the walk DOES see a nested key when one is present', () => {
    expect(deepKeys({ a: { b: [{ rateCents: 1 }] } })).toContain('rateCents');
  });

  it('carries no money, no secret, no address — anywhere in the DTO', () => {
    const cards = buildCasesIndexCards([caseRow()], context({ featuredEngagementId: 'eng-1' }));
    const keys = deepKeys(cards).map((key) => key.toLowerCase());
    expect(keys.length).toBeGreaterThan(0);
    for (const denied of DENIED_KEYS) {
      expect(keys).not.toContain(denied);
    }
  });

  it('carries no meeting SECRET as a VALUE either, only the member call route', () => {
    const cards = buildCasesIndexCards([caseRow()], context({ featuredEngagementId: 'eng-1' }));
    const serialized = JSON.stringify(cards);
    expect(serialized).toContain('/meetings/m-1/call');
    expect(serialized).not.toContain('daily.co');
    expect(serialized).not.toContain('/join/m/');
  });
});

// ── Counterparty, side-relative ───────────────────────────────────────────────────────────────

describe('the counterparty', () => {
  it('CLIENT side — names the expert PERSON, their agency, and their profile href', () => {
    const card = firstCard([caseRow()], context({ side: 'company' }));
    expect(card).toMatchObject({
      counterpartyName: 'Marcus Lee',
      counterpartyOrgLabel: 'Stratus Advisory',
      counterpartyInitials: 'ML',
      bookAgainHref: '/experts/marcus',
    });
    expect(card.counterpartyAvatarUrl).toBe('https://cdn.example/marcus.png');
  });

  it('EXPERT side — names the client COMPANY, with no org line and no booking href', () => {
    const card = firstCard([caseRow()], context({ side: 'expert' }));
    expect(card).toMatchObject({
      counterpartyName: 'Acme Corp',
      counterpartyOrgLabel: null,
      counterpartyInitials: 'AC',
      counterpartyAvatarUrl: null,
      bookAgainHref: null,
    });
  });

  it('renders NO booking href when the expert has no username', () => {
    const card = firstCard([caseRow({ expertUsername: null })], context());
    expect(card.bookAgainHref).toBeNull();
  });

  it('falls back to "An expert" when every name column is null', () => {
    const card = firstCard([caseRow({ expertFirstName: null, expertLastName: null })], context());
    expect(card.counterpartyName).toBe('An expert');
  });
});

// ── The action-item count is SIDE-relative ────────────────────────────────────────────────────

describe('"{n} for you"', () => {
  it('counts the CLIENT’s items on the client side', () => {
    expect(firstCard([caseRow()], context({ side: 'company' })).actionItemsForYou).toBe(2);
  });

  it('counts the EXPERT’s items on the expert side', () => {
    expect(firstCard([caseRow()], context({ side: 'expert' })).actionItemsForYou).toBe(5);
  });

  it('is zero for a case with no open items at all', () => {
    const card = firstCard([caseRow()], context({ actionItemsByEngagement: new Map() }));
    expect(card.actionItemsForYou).toBe(0);
  });
});

// ── Card state, through `selectCaseNudge` ─────────────────────────────────────────────────────

describe('the card state', () => {
  it('is `booked` for an upcoming consultation', () => {
    expect(firstCard([caseRow()], context()).cardState).toBe('booked');
  });

  it('is `proposal` on the client side when a LIVE proposal sits on the next meeting', () => {
    const card = firstCard(
      [caseRow()],
      context({
        side: 'company',
        proposalByMeetingId: new Map([['m-1', proposal()]]),
        actorFirstNameById: new Map([[EXPERT_USER_ID, 'Marcus']]),
      })
    );
    expect(card).toMatchObject({
      cardState: 'proposal',
      proposalOptionCount: 3,
      actorLabel: 'Marcus',
    });
  });

  it('is `proposal_pending` on the EXPERT side — the same proposal, the other side', () => {
    const card = firstCard(
      [caseRow()],
      context({
        side: 'expert',
        proposalByMeetingId: new Map([['m-1', proposal()]]),
        actorFirstNameById: new Map([[EXPERT_USER_ID, 'Marcus']]),
      })
    );
    expect(card.cardState).toBe('proposal_pending');
  });

  it('is `resolution_ask` on the client side with nothing booked', () => {
    const card = firstCard(
      [
        caseRow({
          resolutionRequestedAt: new Date('2026-09-14T00:00:00.000Z'),
          resolutionRequestedByUserId: EXPERT_USER_ID,
          nextBookingAt: null,
        }),
      ],
      context({
        trailByEngagement: new Map([
          ['eng-1', [trailMeeting({ status: 'ended', outcome: 'completed' })]],
        ]),
        actorFirstNameById: new Map([[EXPERT_USER_ID, 'Marcus']]),
      })
    );
    expect(card).toMatchObject({ cardState: 'resolution_ask', actorLabel: 'Marcus' });
  });

  it('is `nothing_booked` with a trail, and `no_calls` without one', () => {
    const withTrail = firstCard(
      [caseRow({ nextBookingAt: null })],
      context({
        trailByEngagement: new Map([
          ['eng-1', [trailMeeting({ status: 'ended', outcome: 'completed' })]],
        ]),
      })
    );
    const withoutTrail = firstCard(
      [caseRow({ nextBookingAt: null })],
      context({ trailByEngagement: new Map() })
    );
    expect(withTrail.cardState).toBe('nothing_booked');
    expect(withoutTrail.cardState).toBe('no_calls');
  });

  it('NEVER stamps `live` — that is the viewer’s clock’s answer', () => {
    const card = firstCard(
      [caseRow({ nextBookingAt: new Date(NOW.getTime() + MIN) })],
      context({
        featuredEngagementId: 'eng-1',
        trailByEngagement: new Map([
          ['eng-1', [trailMeeting({ scheduledStart: new Date(NOW.getTime() + MIN) })]],
        ]),
      })
    );
    expect(card.cardState).toBe('booked');
  });
});

// ── Attribution wiring ────────────────────────────────────────────────────────────────────────

describe('attribution', () => {
  it('CLIENT side — an agency COLLEAGUE reads "{First name} @ {Agency}"', () => {
    const card = firstCard(
      [
        caseRow({
          nextBookingAt: null,
          resolutionRequestedAt: new Date('2026-09-14T00:00:00.000Z'),
          resolutionRequestedByUserId: COLLEAGUE_USER_ID,
        }),
      ],
      context({
        side: 'company',
        trailByEngagement: new Map(),
        actorFirstNameById: new Map([[COLLEAGUE_USER_ID, 'Priya']]),
      })
    );
    expect(card.actorLabel).toBe('Priya @ Stratus Advisory');
  });

  it('EXPERT side — the viewer’s own ask reads "You"', () => {
    const card = firstCard(
      [
        caseRow({
          nextBookingAt: null,
          resolutionRequestedAt: new Date('2026-09-14T00:00:00.000Z'),
          resolutionRequestedByUserId: VIEWER_USER_ID,
        }),
      ],
      context({
        side: 'expert',
        trailByEngagement: new Map(),
        actorFirstNameById: new Map([[VIEWER_USER_ID, 'Sam']]),
      })
    );
    expect(card.actorLabel).toBe('You');
  });

  it('falls back to the expert PARTY when the actor’s name cannot be read', () => {
    const card = firstCard(
      [
        caseRow({
          nextBookingAt: null,
          resolutionRequestedAt: new Date('2026-09-14T00:00:00.000Z'),
          resolutionRequestedByUserId: COLLEAGUE_USER_ID,
        }),
      ],
      context({ trailByEngagement: new Map(), actorFirstNameById: new Map() })
    );
    expect(card.actorLabel).toBe('Stratus Advisory');
  });

  it('is null on a state nobody acted on', () => {
    expect(firstCard([caseRow()], context()).actorLabel).toBeNull();
  });
});

// ── The trail ─────────────────────────────────────────────────────────────────────────────────

describe('the trail', () => {
  it('numbers marks BEFORE trimming, so the last six keep their real ordinals', () => {
    const meetings = Array.from({ length: 8 }, (_unused, index) =>
      trailMeeting({ meetingId: `m-${index + 1}`, status: 'ended', outcome: 'completed' })
    );
    const card = firstCard(
      [caseRow({ nextBookingAt: null })],
      context({ trailByEngagement: new Map([['eng-1', meetings]]) })
    );
    expect(card.trail).toHaveLength(6);
    expect(card.trail.map((entry) => entry.ordinal)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('draws a meeting with a live proposal as still BOOKED', () => {
    const card = firstCard(
      [caseRow()],
      context({ proposalByMeetingId: new Map([['m-1', proposal()]]) })
    );
    expect(card.trail).toEqual([{ ordinal: 1, mark: 'booked' }]);
  });
});

// ── Featured, and the join path ───────────────────────────────────────────────────────────────

describe('the featured case', () => {
  it('is row one, and only when it has a booking', () => {
    expect(resolveFeaturedEngagementId([caseRow()])).toBe('eng-1');
    expect(resolveFeaturedEngagementId([caseRow({ nextBookingAt: null })])).toBeNull();
    expect(resolveFeaturedEngagementId([])).toBeNull();
  });

  it('is the ONLY card that carries a join path', () => {
    const rows = [caseRow(), caseRow({ engagementId: 'eng-2' })];
    const cards = buildCasesIndexCards(
      rows,
      context({
        featuredEngagementId: 'eng-1',
        trailByEngagement: new Map([
          ['eng-1', [trailMeeting()]],
          ['eng-2', [trailMeeting({ meetingId: 'm-2' })]],
        ]),
      })
    );
    expect(cards.map((card) => card.joinPath)).toEqual(['/meetings/m-1/call', null]);
  });

  it('carries no join path when the featured case has nothing booked', () => {
    const card = firstCard(
      [caseRow({ nextBookingAt: null })],
      context({ featuredEngagementId: 'eng-1', trailByEngagement: new Map() })
    );
    expect(card.joinPath).toBeNull();
  });
});

describe('nextBookingRoomReady (BAL-581)', () => {
  it('copies roomReady through from the next booking, true and false — never recomputed', () => {
    const readyCard = firstCard(
      [caseRow()],
      context({ trailByEngagement: new Map([['eng-1', [trailMeeting({ roomReady: true })]]]) })
    );
    expect(readyCard.nextBookingRoomReady).toBe(true);

    const notReadyCard = firstCard(
      [caseRow()],
      context({ trailByEngagement: new Map([['eng-1', [trailMeeting({ roomReady: false })]]]) })
    );
    expect(notReadyCard.nextBookingRoomReady).toBe(false);
  });

  it('is null when the case has no next booking', () => {
    const card = firstCard(
      [caseRow({ nextBookingAt: null })],
      context({ trailByEngagement: new Map() })
    );
    expect(card.nextBookingRoomReady).toBeNull();
  });
});

// ── Liveness ──────────────────────────────────────────────────────────────────────────────────

describe('indexLiveProposals', () => {
  it('keeps a proposal whose deadline is ahead of now', () => {
    const live = indexLiveProposals([proposal()], NOW);
    expect([...live.keys()]).toEqual(['m-1']);
  });

  it('DROPS an expired one — liveness is decided here, never trusted from the row', () => {
    const live = indexLiveProposals([proposal({ expiresAt: new Date(NOW.getTime() - MIN) })], NOW);
    expect(live.size).toBe(0);
  });
});

// ── Resolved rows ─────────────────────────────────────────────────────────────────────────────

function resolvedRow(overrides: Partial<CasesIndexResolvedRow> = {}): CasesIndexResolvedRow {
  return {
    engagementId: 'eng-9',
    title: 'Einstein bot handoff',
    companyId: 'co-1',
    companyName: 'Acme Corp',
    expertProfileId: 'ep-1',
    expertUserId: EXPERT_USER_ID,
    expertFirstName: 'Marcus',
    expertLastName: 'Lee',
    expertAvatarUrl: null,
    expertUsername: 'marcus',
    expertHeadline: null,
    expertType: 'agency',
    agencyId: 'ag-1',
    agencyName: 'Stratus Advisory',
    closedAt: new Date('2026-08-03T00:00:00.000Z'),
    closeReason: 'auto_inactive',
    heldCount: 1,
    closedAtEpoch: 1_754_179_200,
    ...overrides,
  };
}

describe('resolved rows', () => {
  it('project the close reason and the held count, with a client-only booking href', () => {
    const [row] = buildCasesIndexResolvedRows([resolvedRow()], 'company');
    expect(row).toEqual({
      engagementId: 'eng-9',
      href: '/cases/eng-9',
      title: 'Einstein bot handoff',
      counterpartyName: 'Marcus Lee',
      counterpartyOrgLabel: 'Stratus Advisory',
      closedAtIso: '2026-08-03T00:00:00.000Z',
      closeReason: 'auto_inactive',
      heldCount: 1,
      bookAgainHref: '/experts/marcus',
    });
  });

  it('never offers the EXPERT side a booking href', () => {
    const [row] = buildCasesIndexResolvedRows([resolvedRow()], 'expert');
    expect(row).toMatchObject({ counterpartyName: 'Acme Corp', bookAgainHref: null });
  });

  it('preserves a NULL close reason rather than guessing one', () => {
    const [row] = buildCasesIndexResolvedRows([resolvedRow({ closeReason: null })], 'company');
    expect(row?.closeReason).toBeNull();
  });
});
