import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';

const mockRequireOnboardedUser = vi.fn();
const mockResolveConversationAccess = vi.fn();
const mockAssertRelationshipBookable = vi.fn();
const mockAssertNoLiveIntroCall = vi.fn();
const mockDeriveBookingIdempotencyKey = vi.fn();
const mockResolveBookingExpertDisplay = vi.fn();
const mockPostBookMeeting = vi.fn();
const mockPostInviteGuests = vi.fn();
const mockPublishNotificationEvent = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotificationEvent(...args),
}));
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveConversationAccess(...args),
}));
vi.mock('@/lib/project-request/assert-relationship-bookable', () => ({
  assertRelationshipBookable: (...args: unknown[]) => mockAssertRelationshipBookable(...args),
}));
vi.mock('@/lib/project-request/assert-no-live-intro-call', () => ({
  assertNoLiveIntroCall: (...args: unknown[]) => mockAssertNoLiveIntroCall(...args),
}));
vi.mock('../booking-idempotency', () => ({
  deriveBookingIdempotencyKey: (...args: unknown[]) => mockDeriveBookingIdempotencyKey(...args),
}));
vi.mock('../load-booking-context', () => ({
  resolveBookingExpertDisplay: (...args: unknown[]) => mockResolveBookingExpertDisplay(...args),
}));
vi.mock('../booking-api-client', () => ({
  postBookMeeting: (...args: unknown[]) => mockPostBookMeeting(...args),
  postInviteGuests: (...args: unknown[]) => mockPostInviteGuests(...args),
}));
import { bookIntroCallAction } from './book-intro-call';
import type { BookIntroCallInput } from './book-intro-call-types';

const USER = {
  id: 'user-1',
  onboardingCompleted: true,
  firstName: 'Sam',
  lastName: 'Reilly',
};
const KEY = 'a'.repeat(64);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-4222-8222-222222222222';
const MEETING_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-8444-444444444444';

const START = '2026-09-01T04:00:00.000Z';
const END = '2026-09-01T04:30:00.000Z';

function input(overrides: Partial<BookIntroCallInput> = {}): BookIntroCallInput {
  return {
    requestId: REQUEST_ID,
    relationshipId: RELATIONSHIP_ID,
    slot: { startIso: START, endIso: END, durationMinutes: 30 },
    bookingNonce: 'b'.repeat(8) + '-0000-4000-8000-000000000000',
    guests: [],
    surface: 'header',
    ...overrides,
  };
}

function accessOk(overrides: { status?: string } = {}) {
  return {
    ok: true as const,
    ctx: { lens: 'client' as const, archetype: 'participant' as const },
    request: {
      title: 'Salesforce CPQ rollout',
      status: overrides.status ?? 'eoi_submitted',
      company: { name: 'Northwind Industrial' },
    },
    relationship: { id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID },
    conversationId: 'conversation-1',
    recipient: { role: 'expert' as const, expertProfileId: EXPERT_PROFILE_ID },
  };
}

/**
 * The FULL published payload — every field the `conversation.intro_call_booked` Zod arm
 * requires. Asserted EXACTLY (see the drift test below), never with `objectContaining`.
 */
const EXPECTED_PAYLOAD = {
  correlationId: MEETING_ID,
  meetingId: MEETING_ID,
  requestId: REQUEST_ID,
  requestTitle: 'Salesforce CPQ rollout',
  relationshipId: RELATIONSHIP_ID,
  recipientId: USER.id,
  expertProfileId: EXPERT_PROFILE_ID,
  clientPersonName: 'Sam Reilly',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak',
  scheduledStartIso: START,
  durationMinutes: 30,
  joinPath: `/join/m/${MEETING_ID}`,
  provisioned: true,
  guestCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockDeriveBookingIdempotencyKey.mockReturnValue(KEY);
  mockResolveConversationAccess.mockResolvedValue(accessOk());
  mockAssertRelationshipBookable.mockResolvedValue(true);
  mockAssertNoLiveIntroCall.mockResolvedValue(true);
  mockResolveBookingExpertDisplay.mockResolvedValue({
    firstName: 'Dana',
    lastName: 'Okoro',
    partyLabel: 'CloudPeak',
  });
  mockPostBookMeeting.mockResolvedValue({
    ok: true,
    data: { meetingId: MEETING_ID, scheduledStart: START, scheduledEnd: END, provisioned: true },
  });
  mockPostInviteGuests.mockResolvedValue({ ok: true, data: { invitedCount: 0 } });
});

describe('bookIntroCallAction', () => {
  it('books against the request_interaction context, keyed on the relationshipId', async () => {
    const result = await bookIntroCallAction(input());

    expect(result).toMatchObject({ ok: true, meetingId: MEETING_ID, provisioned: true });
    expect(mockPostBookMeeting).toHaveBeenCalledWith({
      contextType: 'request_interaction',
      contextId: RELATIONSHIP_ID,
      scheduledStart: START,
      scheduledEnd: END,
      bookingIdempotencyKey: KEY,
    });
  });

  /**
   * ⚠ EXACT, NOT `expect.objectContaining` (round-1 W5). `objectContaining` cannot catch a
   * MISSING key or an EXTRA one, and the original assertion omitted four of the fourteen
   * fields the `conversation.intro_call_booked` Zod arm requires (`requestTitle`,
   * `scheduledStartIso`, `durationMinutes`, `joinPath`). Payload drift against that arm would
   * therefore have shipped GREEN and 400'd at runtime, swallowed by `publishNotificationEvent`.
   * `windowMinutes()` and `memberJoinPath()` were likewise never asserted anywhere.
   */
  it('publishes conversation.intro_call_booked with the COMPLETE payload, exactly', async () => {
    await bookIntroCallAction(input());

    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'conversation.intro_call_booked',
      EXPECTED_PAYLOAD
    );
  });

  it('durationMinutes + scheduledStartIso come from the SERVER window, not the client slot', async () => {
    // The api answers with a DIFFERENT window than the client asked for — S2 precedent says the
    // server's window wins, and the derived duration must follow it.
    mockPostBookMeeting.mockResolvedValue({
      ok: true,
      data: {
        meetingId: MEETING_ID,
        scheduledStart: '2026-09-01T05:00:00.000Z',
        scheduledEnd: '2026-09-01T05:15:00.000Z',
        provisioned: true,
      },
    });

    const result = await bookIntroCallAction(input());

    expect(result).toMatchObject({
      ok: true,
      scheduledStartIso: '2026-09-01T05:00:00.000Z',
      scheduledEndIso: '2026-09-01T05:15:00.000Z',
      durationMinutes: 15,
    });
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith('conversation.intro_call_booked', {
      ...EXPECTED_PAYLOAD,
      scheduledStartIso: '2026-09-01T05:00:00.000Z',
      durationMinutes: 15,
    });
  });

  /**
   * ⚠⚠ THIS ASSERTS THE IMPORT GRAPH, BECAUSE THE PREVIOUS PIN WAS VACUOUS (round-1 W3). The
   * old test `vi.mock`ed `@/lib/credit/actions/session-mutations` and asserted
   * `openSessionAction` was never called — but THE ACTION NEVER IMPORTS THAT SPECIFIER, so the
   * mock was inert and the assertion was vacuously true FOREVER. It would have stayed green if
   * the action started importing `openSession` from `@balo/db`, or `get-drawdown-state`, or
   * `walletRepository`. Ruling 2 is this ticket's central money ruling; its guard cannot be a
   * false green.
   *
   * ⚠ A CWD-CANDIDATE LIST (`resolveRouteDir`), NOT `process.cwd()` alone and not
   * `import.meta.url`: CI runs web vitest from the REPO ROOT while a local run starts in
   * `apps/web` (memory `reference_web_server_disk_asset_cwd`), and `import.meta.url` is not a
   * `file:` URL under vitest's transform.
   *
   * ⚠ AND IT SCANS `codeLinesOf`, NOT THE RAW TEXT — this action's own docblock says "No
   * `openSession`, no credit hold" in prose, so an un-stripped scan would fail on the very
   * comment that documents the rule.
   */
  describe('Ruling 2 pin — the import graph itself', () => {
    const file = resolveRouteDir([
      'src/lib/booking/actions/book-intro-call.ts',
      'apps/web/src/lib/booking/actions/book-intro-call.ts',
    ]);
    const code = codeLinesOf(file === '' ? '' : readFileSync(file, 'utf8'));

    it('guards the guard — the scan really found this module and sees its code', () => {
      expect(file).not.toBe('');
      expect(code).toContain('publishNotificationEvent');
      expect(code).toContain('postBookMeeting');
    });

    it('imports NO credit / wallet / ledger / Stripe module, and names no money primitive', () => {
      expect(code).not.toMatch(/from '[^']*credit/);
      expect(code).not.toMatch(/from '[^']*wallet/);
      expect(code).not.toMatch(/from '[^']*stripe/i);
      expect(code).not.toMatch(
        /openSession|creditHold|drawdown|walletRepository|ledgerRepository|applyLedgerEntry/
      );
    });
  });

  it('not_permitted when un-onboarded (requireOnboardedUser throws)', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('invalid_request on a malformed input (zod)', async () => {
    await expect(bookIntroCallAction(input({ requestId: 'not-a-uuid' }))).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
    });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('not_permitted when conversation access is denied', async () => {
    mockResolveConversationAccess.mockResolvedValue({ ok: false, error: 'denied' });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('not_permitted when the relationship is declined/withdrawn — and NO api call is made', async () => {
    mockAssertRelationshipBookable.mockResolvedValue(false);
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE REQUEST-LIFECYCLE GATE, WEB HALF (round-1 HIGH). `THREAD_OPEN_RELATIONSHIP_STATUSES`
   * includes `'accepted'`, so `resolveConversationAccess` passes an accepted relationship
   * straight through and the UI's `callAllowed` gate is browser-only. Past acceptance the
   * delivering expert's hours must route through the BILLED case/kickoff path.
   */
  it.each(['accepted', 'kickoff_approved'])(
    'not_permitted once the request is %s — and NO api call is made',
    async (status) => {
      mockResolveConversationAccess.mockResolvedValue(accessOk({ status }));
      await expect(bookIntroCallAction(input())).resolves.toEqual({
        ok: false,
        code: 'not_permitted',
      });
      expect(mockPostBookMeeting).not.toHaveBeenCalled();
    }
  );

  it.each(['eoi_submitted', 'proposal_requested', 'proposal_submitted'])(
    'still books at %s — the gate is the DECISION line, not any open thread',
    async (status) => {
      mockResolveConversationAccess.mockResolvedValue(accessOk({ status }));
      await expect(bookIntroCallAction(input())).resolves.toMatchObject({ ok: true });
    }
  );

  it('not_permitted when the thread already has a live intro call — one call per thread', async () => {
    mockAssertNoLiveIntroCall.mockResolvedValue(false);
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE SLOT WINDOW MUST AGREE WITH `durationMinutes` (round-1 security MEDIUM). Without
   * this, `{durationMinutes: 15, slot: 09:00 → 17:00}` passed every check and consumed the
   * expert's whole published day as ONE free confirmed consultation.
   */
  it('invalid_request when the window contradicts durationMinutes — 8h claimed as 15 min', async () => {
    await expect(
      bookIntroCallAction(
        input({
          slot: {
            startIso: '2026-09-01T09:00:00.000Z',
            endIso: '2026-09-01T17:00:00.000Z',
            durationMinutes: 15,
          },
        })
      )
    ).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('invalid_request when an instant is not a datetime', async () => {
    await expect(
      bookIntroCallAction(
        input({ slot: { startIso: 'tomorrow', endIso: END, durationMinutes: 30 } })
      )
    ).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(mockPostBookMeeting).not.toHaveBeenCalled();
  });

  it('invalid_request maps from api 400 context_type_mismatch', async () => {
    mockPostBookMeeting.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'context_type_mismatch',
    });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('slot_unavailable maps from api 409 window_not_available', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 409, code: 'window_not_available' });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'slot_unavailable',
    });
  });

  it('not_permitted maps from api 404 context_not_found', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 404, code: 'context_not_found' });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
  });

  it('rate_limited maps from api 429/503', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 429, code: 'rate_limited' });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
    });

    mockPostBookMeeting.mockResolvedValue({
      ok: false,
      status: 503,
      code: 'rate_limit_unavailable',
    });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
    });
  });

  it('booking_failed on a transport failure (status 0)', async () => {
    mockPostBookMeeting.mockResolvedValue({ ok: false, status: 0, code: 'request_failed' });
    await expect(bookIntroCallAction(input())).resolves.toEqual({
      ok: false,
      code: 'booking_failed',
    });
  });

  it('a guest 409 guest_already_invited counts as invited', async () => {
    mockPostInviteGuests.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'guest_already_invited',
    });
    const result = await bookIntroCallAction(input({ guests: [{ email: 'guest@example.com' }] }));
    expect(result).toMatchObject({ ok: true, guestsInvited: 1, guestInviteFailed: false });
  });

  it('a guest invite failure does NOT fail the booking', async () => {
    mockPostInviteGuests.mockResolvedValue({ ok: false, status: 500, code: 'request_failed' });
    const result = await bookIntroCallAction(input({ guests: [{ email: 'guest@example.com' }] }));
    expect(result).toMatchObject({ ok: true, guestInviteFailed: true, guestsInvited: 0 });
  });
});
