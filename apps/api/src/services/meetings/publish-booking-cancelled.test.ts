import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const {
  mockFindCompanyName,
  mockFindDisplayProfile,
  mockFindCase,
  mockFindUserDisplay,
  mockGetAgencySummary,
  mockListAdminUserIds,
  mockPublish,
} = vi.hoisted(() => ({
  mockFindCompanyName: vi.fn(),
  mockFindDisplayProfile: vi.fn(),
  mockFindCase: vi.fn(),
  mockFindUserDisplay: vi.fn(),
  mockGetAgencySummary: vi.fn(),
  mockListAdminUserIds: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { findNameById: mockFindCompanyName },
  expertsRepository: { findDisplayProfileById: mockFindDisplayProfile },
  caseEngagementsRepository: { findByEngagementId: mockFindCase },
  usersRepository: { findDisplayById: mockFindUserDisplay },
  agenciesRepository: { getSummaryById: mockGetAgencySummary },
  partyMembershipsRepository: { listAdminUserIds: mockListAdminUserIds },
}));
vi.mock('../../notifications/index.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
// ⚠ `@balo/shared/parties` is deliberately NOT mocked — `personWithOrgLabel`'s real
// drop-the-clause rules (blank org, org === person) are part of what the attribution asserts.

import { publishBookingCancelled } from './publish-booking-cancelled.js';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_USER_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_USER_ID = '66666666-6666-4666-8666-666666666666';
const AUDIT_ID = '77777777-7777-4777-8777-777777777777';
const CLIENT_ADMIN_A = '88888888-8888-4888-8888-888888888888';
const CLIENT_ADMIN_B = '99999999-9999-4999-8999-999999999999';

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
} as unknown as FastifyBaseLogger;

const SCHEDULED_START = new Date('2026-09-01T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-09-01T10:30:00.000Z');

function input(
  overrides: Record<string, unknown> = {}
): Parameters<typeof publishBookingCancelled>[0] {
  return {
    meetingId: MEETING_ID,
    subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    actorUserId: ACTOR_USER_ID,
    cancelledBy: 'client',
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    cancelAuditId: AUDIT_ID,
    holdReleased: false,
    ...overrides,
  } as Parameters<typeof publishBookingCancelled>[0];
}

/** The published payload, for assertions. */
function published(): Record<string, unknown> {
  const call = mockPublish.mock.calls[0];
  if (call === undefined) throw new Error('nothing was published');
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindCompanyName.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindDisplayProfile.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    userId: EXPERT_USER_ID,
    agencyId: null,
    type: 'freelancer',
  });
  mockFindCase.mockResolvedValue({ title: 'Flow automation review' });
  mockFindUserDisplay.mockImplementation(async (id: string) =>
    id === EXPERT_USER_ID
      ? { id, firstName: 'Priya', lastName: 'Raman' }
      : { id, firstName: 'Dana', lastName: 'Okoro' }
  );
  mockGetAgencySummary.mockResolvedValue(undefined);
  mockListAdminUserIds.mockResolvedValue([CLIENT_ADMIN_A, CLIENT_ADMIN_B]);
  mockPublish.mockResolvedValue(undefined);
});

// ── The case gate ─────────────────────────────────────────────────────────────

describe('publishBookingCancelled — the v1 case gate', () => {
  it.each([
    'project_kickoff',
    'package_session',
    'retainer_checkin',
    'project_discovery',
    'request_interaction',
  ])('publishes NOTHING for a %s context, and logs the skip', async (contextType) => {
    await publishBookingCancelled(
      input({ subject: { contextType, contextId: ENGAGEMENT_ID } }),
      log
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ contextType }),
      expect.stringContaining('case consultations only')
    );
  });

  it('publishes NOTHING when no owning company resolved', async () => {
    await publishBookingCancelled(input({ companyId: null }), log);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes NOTHING when the context names no expert', async () => {
    await publishBookingCancelled(input({ expertProfileId: null }), log);

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

// ── The correlation key ───────────────────────────────────────────────────────

describe('publishBookingCancelled — the correlationId', () => {
  it('⚠ is `${meetingId}:${cancelAuditId}` — per WRITE, never per STATE', async () => {
    // A bare meetingId would collide against BullMQ's retained completed set, and a cancel has
    // no destination window to key on because nothing moved.
    await publishBookingCancelled(input(), log);

    expect(mockPublish).toHaveBeenCalledWith('booking.cancelled', expect.anything());
    expect(published().correlationId).toBe(`${MEETING_ID}:${AUDIT_ID}`);
  });
});

// ── Recipient shape — A1, the AC gap this closes ──────────────────────────────

describe('publishBookingCancelled — who gets told', () => {
  it('CLIENT arm: `recipientId` is the actor, and NO fan-out list (nobody told twice)', async () => {
    await publishBookingCancelled(input({ cancelledBy: 'client' }), log);

    expect(published().recipientId).toBe(ACTOR_USER_ID);
    expect(published()).not.toHaveProperty('recipientUserIds');
    expect(mockListAdminUserIds).not.toHaveBeenCalled();
  });

  it.each(['expert', 'admin'])(
    '%s arm: NO `recipientId`, and the CLIENT company’s members ARE fanned out',
    async (cancelledBy) => {
      // ⚠ THIS IS THE AC "Cancelled by expert → client → email + in-app". Without the fan-out
      // the client is never told, because `recipient: 'client'` resolves only a single
      // `payload.recipientId` which does not exist on these arms.
      await publishBookingCancelled(input({ cancelledBy }), log);

      expect(published()).not.toHaveProperty('recipientId');
      expect(published().recipientUserIds).toEqual([CLIENT_ADMIN_A, CLIENT_ADMIN_B]);
      expect(mockListAdminUserIds).toHaveBeenCalledWith('company', COMPANY_ID);
    }
  );

  it('⚠ WARNS loudly when the client company has no live member to reach', async () => {
    // Both client-side channels fan out from this list; an empty one delivers nothing, and a
    // silent send is the one shape a promise must never take.
    mockListAdminUserIds.mockResolvedValue([]);

    await publishBookingCancelled(input({ cancelledBy: 'expert' }), log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, cancelledBy: 'expert' }),
      expect.stringContaining('reaches nobody')
    );
    // …and the expert half still publishes.
    expect(mockPublish).toHaveBeenCalled();
  });

  it('a FAILING recipient read degrades to no fan-out, and still publishes for the expert', async () => {
    mockListAdminUserIds.mockRejectedValue(new Error('connection terminated'));

    await publishBookingCancelled(input({ cancelledBy: 'expert' }), log);

    expect(mockPublish).toHaveBeenCalled();
    expect(published()).not.toHaveProperty('recipientUserIds');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('the expert is still notified')
    );
  });
});

// ── Attribution by tense (CLAUDE.md) ──────────────────────────────────────────

describe('publishBookingCancelled — cancelledByLabel', () => {
  it('CLIENT arm: the PERSON with "@ company" on first mention', async () => {
    await publishBookingCancelled(input({ cancelledBy: 'client' }), log);

    expect(published().cancelledByLabel).toBe('Dana Okoro @ Northwind Industrial');
  });

  it('EXPERT arm: the PERSON with "@ agency"', async () => {
    mockFindDisplayProfile.mockResolvedValue({
      id: EXPERT_PROFILE_ID,
      userId: EXPERT_USER_ID,
      agencyId: 'agency-1',
      type: 'agency',
    });
    mockGetAgencySummary.mockResolvedValue({ id: 'agency-1', name: 'CloudPeak' });
    mockFindUserDisplay.mockResolvedValue({ id: ACTOR_USER_ID, firstName: 'Sam', lastName: 'Lee' });

    await publishBookingCancelled(input({ cancelledBy: 'expert' }), log);

    expect(published().cancelledByLabel).toBe('Sam Lee @ CloudPeak');
  });

  it('⚠ ADMIN arm: the literal "Balo support" — a staff member is NEVER named to the parties', async () => {
    await publishBookingCancelled(input({ cancelledBy: 'admin' }), log);

    expect(published().cancelledByLabel).toBe('Balo support');
  });

  it('degrades to the acting side’s PARTY label when the person read yields no name', async () => {
    mockFindUserDisplay.mockImplementation(async (id: string) =>
      id === EXPERT_USER_ID
        ? { id, firstName: 'Priya', lastName: 'Raman' }
        : { id, firstName: null, lastName: null }
    );

    await publishBookingCancelled(input({ cancelledBy: 'client' }), log);

    expect(published().cancelledByLabel).toBe('Northwind Industrial');
  });
});

// ── Labels ────────────────────────────────────────────────────────────────────

describe('publishBookingCancelled — labels and fallbacks', () => {
  it('names the PARTY prospectively: the client company and the expert party', async () => {
    await publishBookingCancelled(input(), log);

    expect(published()).toMatchObject({
      clientCompanyName: 'Northwind Industrial',
      // A freelancer's party label IS their own name (`expertPartyDisplayName`).
      expertPartyLabel: 'Priya Raman',
      caseTitle: 'Flow automation review',
    });
  });

  it('⚠ builds the expert party label from the EXPERT’s user row, never the ACTOR’s', async () => {
    // Using the actor would name the CLIENT as the expert party on every client-initiated
    // cancel — the single most likely way to get this wrong.
    await publishBookingCancelled(input({ cancelledBy: 'client' }), log);

    expect(published().expertPartyLabel).toBe('Priya Raman');
    expect(published().expertPartyLabel).not.toBe('Dana Okoro');
  });

  it('a FAILING label read publishes with neutral fallbacks, and logs', async () => {
    mockFindCompanyName.mockRejectedValue(new Error('connection terminated'));

    await publishBookingCancelled(input(), log);

    expect(published()).toMatchObject({
      clientCompanyName: 'your company',
      expertPartyLabel: 'Your expert',
      caseTitle: 'your case',
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('neutral fallbacks')
    );
  });
});

// ── The rest of the payload ───────────────────────────────────────────────────

describe('publishBookingCancelled — the payload', () => {
  it('carries the released window, the duration and the server-derived arm', async () => {
    await publishBookingCancelled(input({ cancelledBy: 'expert' }), log);

    expect(published()).toMatchObject({
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      scheduledStartIso: SCHEDULED_START.toISOString(),
      durationMinutes: 30,
      cancelledBy: 'expert',
    });
  });

  it('`reason` defaults to "requested" — no shipped caller passes anything else', async () => {
    await publishBookingCancelled(input(), log);

    expect(published().reason).toBe('requested');
  });

  it('carries the BAL-416 reason variant when a caller passes it', async () => {
    await publishBookingCancelled(input({ reason: 'expert_time_off' }), log);

    expect(published().reason).toBe('expert_time_off');
  });

  it('threads holdReleased through unchanged', async () => {
    await publishBookingCancelled(input({ holdReleased: true }), log);

    expect(published().holdReleased).toBe(true);
  });

  it('⚠ carries NO email address and NO money field (ADR-1044 §3 + fee concealment)', async () => {
    await publishBookingCancelled(input({ holdReleased: true }), log);

    // ⚠⚠ THE TEST IS "NO **ADDRESS**-SHAPED `@`", NOT "NO `@`" — and the distinction is the
    // whole attribution rule. `cancelledByLabel` legitimately carries the CLAUDE.md retrospective
    // form `"Dana Okoro @ Northwind Industrial"`, where the `@` is a SPACED separator between a
    // person and an org. An email address never has spaces around its `@`, so requiring every
    // `@` to be space-delimited on BOTH sides admits the attribution form and rejects an address.
    //
    // ⚠ Scanned per FIELD with an index walk rather than a regex over a serialized blob: a
    // payload is a keyed object, and this cannot become a super-linear pattern (ESLint
    // `regexp/no-super-linear-move` / Sonar S5852).
    for (const [key, value] of Object.entries(published())) {
      if (typeof value !== 'string') continue;
      for (let i = value.indexOf('@'); i !== -1; i = value.indexOf('@', i + 1)) {
        expect(`${key}: ${value}`).toSatisfy(() => value[i - 1] === ' ' && value[i + 1] === ' ');
      }
    }
    for (const forbidden of [
      'recipientEmail',
      'rateMinor',
      'amountMinor',
      'holdAmount',
      'baloFeeBps',
      'total',
    ]) {
      expect(published()).not.toHaveProperty(forbidden);
    }
  });
});
