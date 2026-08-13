import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import type { RecapContextType } from '@/lib/meetings/end-of-call-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const REQUESTER_ID = 'f0000000-0000-4000-8000-000000000006';

vi.mock('server-only', () => ({}));

const mockFindTranscript = vi.fn();
const mockFindCompany = vi.fn();
const mockFindProfile = vi.fn();
const mockFindCase = vi.fn();
const mockCreditSessions = vi.fn();
const mockFindNames = vi.fn();

vi.mock('@balo/db', () => ({
  transcriptsRepository: { findByMeetingId: (...a: unknown[]) => mockFindTranscript(...a) },
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompany(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  caseEngagementsRepository: { findByEngagementId: (...a: unknown[]) => mockFindCase(...a) },
  // Present ONLY so a regression that starts reading money here fails loudly rather than
  // exploding on a missing export. Nothing in the loader may call it.
  creditSessionsRepository: { findIdByMeetingId: (...a: unknown[]) => mockCreditSessions(...a) },
  usersRepository: {
    findDisplayById: vi.fn(),
    findNamesByIds: (...a: unknown[]) => mockFindNames(...a),
  },
  agenciesRepository: { getSummaryById: vi.fn() },
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-recap-access', () => ({
  resolveRecapAccess: (...a: unknown[]) => mockResolveAccess(...a),
}));

const mockReadReview = vi.fn();
vi.mock('@/lib/reviews/read-engagement-review', () => ({
  readEngagementReview: (...a: unknown[]) => mockReadReview(...a),
}));

const mockCounterparty = vi.fn();
const mockFormatRequester = vi.fn();
vi.mock('../../_lib/resolve-counterparty', () => ({
  resolveCounterparty: (...a: unknown[]) => mockCounterparty(...a),
  // ⚠ THE **FORMATTER**, NOT THE FETCH-AND-FORMAT PAIR. BAL-389's UX pass moved the requester
  // read out from behind `resolveCounterparty` and into a `Promise.all` beside it, so the loader
  // now issues `usersRepository.findNamesByIds` itself and formats the row through the shared
  // helper. `resolveRequesterLabel` still exists and `load-recap.ts` still uses it.
  formatRequesterLabel: (...a: unknown[]) => mockFormatRequester(...a),
}));

import { loadEndOfCall } from './load-end-of-call';

const STARTED = new Date('2026-08-12T09:00:00.000Z');
const ENDED = new Date('2026-08-12T09:45:00.000Z');

/**
 * The clock is INJECTED into every call in this file. The post-call guard is a comparison against
 * `now`, so a suite that let it read the wall clock would silently change meaning as time passed —
 * the "future meeting" fixture would eventually become a past one.
 */
const NOW = new Date('2026-08-12T10:00:00.000Z');
/** Before `NOW` — the ordinary case, and the one the guard must ALLOW. */
const PAST_START = new Date('2026-08-12T09:00:00.000Z');
/** After `NOW` — the hand-typed-URL case the guard must DENY. */
const FUTURE_START = new Date('2026-08-12T11:00:00.000Z');

function meeting(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    scheduledStart: PAST_START,
    startedAt: STARTED,
    endedAt: ENDED,
    status: 'scheduled',
    ...over,
  };
}

function access(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lens: 'client',
    meeting: meeting(),
    subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    ...over,
  };
}

function seed(): void {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue(access());
  mockFindTranscript.mockResolvedValue({ id: 't1', status: 'processing' });
  mockFindCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({ id: PROFILE_ID, userId: 'u-expert', agencyId: null });
  mockFindCase.mockResolvedValue({
    engagementId: ENGAGEMENT_ID,
    closedAt: null,
    closeReason: null,
    resolutionRequestedAt: null,
    resolutionRequestedByUserId: null,
  });
  mockReadReview.mockResolvedValue({ review: null, state: { kind: 'none' } });
  mockCounterparty.mockResolvedValue({
    party: {},
    expertPersonLabel: 'Amara Okafor @ CloudPeak',
    expertPartyShort: 'CloudPeak',
    expertShortName: 'Amara',
    agencyLabel: 'CloudPeak',
  });
  mockFindNames.mockResolvedValue([{ id: REQUESTER_ID, firstName: 'Amara', lastName: 'Okafor' }]);
  mockFormatRequester.mockReturnValue('Amara Okafor @ CloudPeak');
}

/** The case row shape, with the resolution-request pair supplied per test. */
function caseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engagementId: ENGAGEMENT_ID,
    closedAt: null,
    closeReason: null,
    resolutionRequestedAt: null,
    resolutionRequestedByUserId: null,
    ...over,
  };
}

describe('loadEndOfCall — the gate', () => {
  beforeEach(seed);

  it('returns ONE null for every denial, and reads nothing further', async () => {
    mockResolveAccess.mockResolvedValue(null);
    expect(await loadEndOfCall(MEETING_ID, USER_ID, NOW)).toBeNull();
    expect(mockFindTranscript).not.toHaveBeenCalled();
    expect(mockReadReview).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('asks the SHIPPED recap gate, never a second resolution chain', async () => {
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockResolveAccess).toHaveBeenCalledWith(MEETING_ID, USER_ID);
  });

  it('RENDERS a meeting that has not ended — no WHOLE-ROUTE lifecycle guard, deliberately', async () => {
    // ⚠ THE DELIBERATE DIVERGENCE FROM THE RECAP. `meetings.status` has no live transition
    // writer (BAL-134 is Backlog), so every real row sits at `scheduled`; copying the recap's
    // terminal-status guard would 404 this screen in 100% of sessions. This screen carries no
    // money, no artefact claims and no status chip, so it states none of the first three
    // falsehoods that guard exists to prevent — and the fourth (offering the close) is answered
    // by the post-call guard below, which removes the CONTROLS rather than the route.
    for (const status of ['scheduled', 'waiting_for_participants', 'in_progress'] as const) {
      mockResolveAccess.mockResolvedValue(
        access({ meeting: meeting({ startedAt: null, endedAt: null, status }) })
      );
      const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
      expect(view, status + ' must still render').not.toBeNull();
      expect(view?.durationMinutes).toBeNull();
    }
  });
});

/**
 * BAL-389 SECURITY FIX — the RENDER half of the post-call guard
 * (`scheduled_start <= now AND status != 'cancelled'`).
 *
 * ⚠ THE SERVER HALF IS `resolveCaseAction`'s, and it is the load-bearing one: this loader only
 * decides what is OFFERED. Both consume ONE predicate, `meetingAllowsPostCallActions`.
 */
describe('loadEndOfCall — the post-call guard on the two consequential controls', () => {
  beforeEach(seed);

  it('DENIES a FUTURE meeting — no rating prompt, no resolve prompt, ABSENT not disabled', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ meeting: meeting({ scheduledStart: FUTURE_START, startedAt: null, endedAt: null }) })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    // The route itself still renders — only the two controls go.
    expect(view).not.toBeNull();
    expect(view).toMatchObject({ lens: 'client', rating: null, resolve: null });
  });

  it('DENIES a future meeting WITHOUT EVEN READING the rating or the case row', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ meeting: meeting({ scheduledStart: FUTURE_START }) })
    );
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockReadReview).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('DENIES a CANCELLED meeting even though its start has passed', async () => {
    mockResolveAccess.mockResolvedValue(access({ meeting: meeting({ status: 'cancelled' }) }));
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({ lens: 'client', rating: null, resolve: null });
    expect(mockReadReview).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('ALLOWS a past-start meeting still sitting at `scheduled` — the 100% case today', async () => {
    // ⚠ THE ASSERTION THAT KEEPS THE FEATURE ALIVE. Nothing writes `started_at` and nothing
    // transitions `status`, so a guard keyed on either would deny every real session.
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'client' });
    expect(view?.lens === 'client' ? view.rating : null).not.toBeNull();
    expect(view?.lens === 'client' ? view.resolve : null).not.toBeNull();
    expect(mockReadReview).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
    expect(mockFindCase).toHaveBeenCalledWith(ENGAGEMENT_ID);
  });

  it('reads the clock it is GIVEN — the same row flips on `now` alone', async () => {
    // One fixture, two verdicts. Nothing about the meeting changes; only the injected clock does.
    const beforeStart = new Date(PAST_START.getTime() - 1);
    expect(await loadEndOfCall(MEETING_ID, USER_ID, beforeStart)).toMatchObject({
      lens: 'client',
      rating: null,
      resolve: null,
    });

    seed();
    const atStart = await loadEndOfCall(MEETING_ID, USER_ID, PAST_START);
    expect(atStart?.lens === 'client' ? atStart.resolve : null).not.toBeNull();
  });

  /**
   * ⚠⚠ THE COPY HALF OF THE SAME FIX. Nulling the two controls was only half of it: the shell
   * still said "Consultation complete" over a success tick and promised a receipt. It cannot
   * recover the fact from `rating`/`resolve` (both are ALSO null on a non-rateable or non-case
   * context, and the expert arm has neither field), so the predicate is carried explicitly.
   */
  it.each([
    ['a past-start meeting', {}, true],
    ['a FUTURE meeting', { scheduledStart: FUTURE_START }, false],
    ['a CANCELLED meeting', { status: 'cancelled' }, false],
  ] as const)('reports meetingHeld for %s', async (_label, over, expected) => {
    mockResolveAccess.mockResolvedValue(access({ meeting: meeting(over) }));
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.meetingHeld).toBe(expected);
  });

  it('carries meetingHeld on the EXPERT arm too — the copy is as untrue on that side', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ lens: 'expert', meeting: meeting({ scheduledStart: FUTURE_START }) })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'expert', meetingHeld: false });
  });

  it('leaves the EXPERT arm untouched — it has neither field to begin with', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ lens: 'expert', meeting: meeting({ scheduledStart: FUTURE_START }) })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.lens).toBe('expert');
    expect(view).not.toHaveProperty('rating');
    expect(view).not.toHaveProperty('resolve');
  });
});

describe('loadEndOfCall — the CLIENT arm', () => {
  beforeEach(seed);

  it('carries the rating state THROUGH UNTOUCHED from the resolver', async () => {
    mockReadReview.mockResolvedValue({
      review: { rating: 3, body: 'Nearly there.', ratedOnIso: '2026-08-01T00:00:00.000Z' },
      state: { kind: 'rated_low', rating: 3 },
    });
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.lens).toBe('client');
    expect(view).toMatchObject({
      lens: 'client',
      rating: {
        engagementId: ENGAGEMENT_ID,
        state: { kind: 'rated_low', rating: 3 },
        existingBody: 'Nearly there.',
      },
    });
    expect(mockReadReview).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('prefills the note from the existing body, and NULLs it when there is none', async () => {
    mockReadReview.mockResolvedValue({
      review: { rating: 5, body: null, ratedOnIso: '2026-08-01T00:00:00.000Z' },
      state: { kind: 'rated_ok', rating: 5 },
    });
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'client', rating: { existingBody: null } });
  });

  it('names the EXPERT as the counterparty, by given name', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.counterpartyName).toBe('Amara');
    // ⚠ NO ORDINAL LINE — the design pass did not adopt "consultation N of M" on this screen.
    expect(mockCounterparty).toHaveBeenCalledWith(
      'client',
      expect.anything(),
      'Northwind Industrial',
      null
    );
  });

  it('builds the resolve view from the case row', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({
      lens: 'client',
      resolve: {
        engagementId: ENGAGEMENT_ID,
        requesterLabel: null,
        alreadyClosed: false,
        expertShortName: 'Amara',
      },
    });
  });

  it('reports alreadyClosed once closed_at is set', async () => {
    mockFindCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      closedAt: new Date('2026-08-12T10:00:00.000Z'),
      closeReason: 'resolved',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'client', resolve: { alreadyClosed: true } });
  });

  it('builds the requester label through the SHARED formatter, retrospectively', async () => {
    mockFindCase.mockResolvedValue(
      caseRow({
        resolutionRequestedAt: new Date('2026-08-11T00:00:00.000Z'),
        resolutionRequestedByUserId: REQUESTER_ID,
      })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockFindNames).toHaveBeenCalledWith([REQUESTER_ID]);
    // ⚠ The FORMATTING stays shared with the recap's R4 banner — only the FETCH moved.
    expect(mockFormatRequester).toHaveBeenCalledWith(
      { id: REQUESTER_ID, firstName: 'Amara', lastName: 'Okafor' },
      'CloudPeak',
      'Amara'
    );
    expect(view).toMatchObject({
      lens: 'client',
      resolve: { requesterLabel: 'Amara Okafor @ CloudPeak' },
    });
  });

  it('leaves the requester label null when only ONE of the paired columns is set', async () => {
    mockFindCase.mockResolvedValue(
      caseRow({ resolutionRequestedAt: new Date('2026-08-11T00:00:00.000Z') })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockFindNames).not.toHaveBeenCalled();
    expect(mockFormatRequester).not.toHaveBeenCalled();
    expect(view).toMatchObject({ lens: 'client', resolve: { requesterLabel: null } });
  });

  it('issues NO requester read at all when nobody has asked', async () => {
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockFindNames).not.toHaveBeenCalled();
  });

  it('fetches the requester name ALONGSIDE the counterparty, never behind it', async () => {
    /**
     * ⚠⚠ THE PIN FOR THE FOURTH-ROUND-TRIP FIX. The requester read only ever needed
     * `case_engagements.resolution_requested_by_user_id`, which the first batch already
     * returned — yet it sat behind `resolveCounterparty`, adding a fourth sequential hop
     * (gate → batch → counterparty → requester) to a screen whose whole job is to paint fast.
     * `resolveCounterparty` is held open here: if the two are concurrent the requester query has
     * ALREADY been issued by the time it resolves, and if they are sequential it cannot have
     * been.
     */
    mockFindCase.mockResolvedValue(
      caseRow({
        resolutionRequestedAt: new Date('2026-08-11T00:00:00.000Z'),
        resolutionRequestedByUserId: REQUESTER_ID,
      })
    );
    let requesterReadWasAlreadyIssued = false;
    mockCounterparty.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            requesterReadWasAlreadyIssued = mockFindNames.mock.calls.length > 0;
            resolve({
              party: {},
              expertPersonLabel: 'Amara Okafor @ CloudPeak',
              expertPartyShort: 'CloudPeak',
              expertShortName: 'Amara',
              agencyLabel: 'CloudPeak',
            });
          }, 0);
        })
    );

    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(requesterReadWasAlreadyIssued).toBe(true);
  });

  it('yields resolve: null when the case row is missing', async () => {
    mockFindCase.mockResolvedValue(undefined);
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'client', resolve: null });
  });
});

describe('loadEndOfCall — context grain decides what is offered', () => {
  beforeEach(seed);

  const NON_CASE: readonly RecapContextType[] = [
    'project_kickoff',
    'project_discovery',
    'package_session',
    'retainer_checkin',
    'request_interaction',
  ];

  it('offers NO resolve prompt on any non-case context, and never reads the case row', async () => {
    for (const contextType of NON_CASE) {
      seed();
      mockResolveAccess.mockResolvedValue(
        access({ subject: { contextType, contextId: ENGAGEMENT_ID } })
      );
      const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
      expect(view, contextType).toMatchObject({ lens: 'client', resolve: null, isCase: false });
      expect(mockFindCase, contextType + ' must not read the case row').not.toHaveBeenCalled();
    }
  });

  it('offers NO rating on a context whose write path would always fail', async () => {
    // Request-grain (`contextId` is not an engagement id) plus the two declared-but-unbuilt
    // engagement kinds `applyReview` refuses. Offering a control that can only error is worse
    // than not offering it.
    for (const contextType of [
      'project_discovery',
      'package_session',
      'retainer_checkin',
      'request_interaction',
    ] as const) {
      seed();
      mockResolveAccess.mockResolvedValue(
        access({ subject: { contextType, contextId: ENGAGEMENT_ID } })
      );
      const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
      expect(view, contextType).toMatchObject({ lens: 'client', rating: null });
      expect(mockReadReview, contextType).not.toHaveBeenCalled();
    }
  });

  it('DOES offer a rating on project_kickoff — engagement-grain and reviewable', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ subject: { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID } })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view).toMatchObject({ lens: 'client', isCase: false });
    expect(view?.lens === 'client' ? view.rating : null).not.toBeNull();
  });
});

describe('loadEndOfCall — the EXPERT arm is structural', () => {
  beforeEach(() => {
    seed();
    mockResolveAccess.mockResolvedValue(access({ lens: 'expert' }));
  });

  it('constructs the arm with NO rating and NO resolve key at all', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.lens).toBe('expert');
    // ⚠ ABSENT KEYS, not null values — there is no optional property for a bug to populate.
    expect(view).not.toHaveProperty('rating');
    expect(view).not.toHaveProperty('resolve');
  });

  it('NEVER READS the rating or the case row — the data does not enter the process', async () => {
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockReadReview).not.toHaveBeenCalled();
    expect(mockFindCase).not.toHaveBeenCalled();
  });

  it('names the client COMPANY as the counterparty, never a person', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.counterpartyName).toBe('Northwind Industrial');
  });

  it('degrades to a neutral party name when the company read comes back empty', async () => {
    mockFindCompany.mockResolvedValue(undefined);
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.counterpartyName).toBe('the client');
  });
});

describe('loadEndOfCall — duration and recap readiness', () => {
  beforeEach(seed);

  it('derives whole minutes when both stamps are present', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.durationMinutes).toBe(45);
  });

  it('is NULL when either stamp is missing — never a fallback to the scheduled window', async () => {
    mockResolveAccess.mockResolvedValue(
      access({ meeting: meeting({ startedAt: STARTED, endedAt: null, status: 'ended' }) })
    );
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(view?.durationMinutes).toBeNull();
  });

  it("reports 'ready' only for a ready transcript", async () => {
    mockFindTranscript.mockResolvedValue({ id: 't1', status: 'ready' });
    expect((await loadEndOfCall(MEETING_ID, USER_ID, NOW))?.recapState).toBe('ready');
  });

  it("reports 'processing' when there is no transcript row at all", async () => {
    mockFindTranscript.mockResolvedValue(undefined);
    expect((await loadEndOfCall(MEETING_ID, USER_ID, NOW))?.recapState).toBe('processing');
  });
});

describe('loadEndOfCall — NOTHING MONEY-SHAPED CAN REACH THE PAYLOAD', () => {
  beforeEach(seed);

  it('never calls the credit-session repository, on either lens', async () => {
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    mockResolveAccess.mockResolvedValue(access({ lens: 'expert' }));
    await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    expect(mockCreditSessions).not.toHaveBeenCalled();
  });

  it('emits a payload with no money-shaped key', async () => {
    const view = await loadEndOfCall(MEETING_ID, USER_ID, NOW);
    const serialised = JSON.stringify(view);
    for (const shape of ['money', 'Minor', 'rate', 'credit', 'charge', 'payout', 'invoice']) {
      expect(serialised.toLowerCase(), 'payload must not carry ' + shape).not.toContain(
        shape.toLowerCase()
      );
    }
  });
});

/**
 * ⚠ A SOURCE ASSERTION, because the runtime one cannot see an import that is never exercised.
 * The threshold must be decided ONCE, inside `readEngagementReview` → `resolveEndOfCallReviewState`
 * with its DEFAULT `LOW_RATING_THRESHOLD` — the injectable default-parameter seam that satisfies
 * the ticket's stale "read from config" AC.
 */
describe('loadEndOfCall — the rating boundary is decided ELSEWHERE', () => {
  const LOADER = 'app/(dashboard)/meetings/[meetingId]/end/_lib/load-end-of-call.ts';
  const loaderPath = resolveRouteDir(['src/' + LOADER, 'apps/web/src/' + LOADER]);

  it('guards the guard — the loader source was actually found', () => {
    expect(loaderPath).not.toBe('');
  });

  it('imports neither the threshold nor the resolver, and compares no literal', () => {
    const code = codeLinesOf(readFileSync(loaderPath, 'utf8'));
    expect(code).not.toContain('LOW_RATING_THRESHOLD');
    expect(code).not.toContain('resolveEndOfCallReviewState');
    for (const shape of ['< 4', '<4', '>= 4', '>=4']) {
      expect(code.includes(shape), 'loader must not re-derive the boundary (' + shape + ')').toBe(
        false
      );
    }
  });
});
