import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockResolveConversationAccess = vi.fn();
const mockAssertRelationshipBookable = vi.fn();
const mockHasExpertDeliveryCapability = vi.fn();
const mockStampAvailabilityShared = vi.fn();
const mockListConnectionsByExpertProfileId = vi.fn();
const mockResolveBookingExpertDisplay = vi.fn();
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
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...args: unknown[]) => mockHasExpertDeliveryCapability(...args),
}));
vi.mock('@/lib/booking/load-booking-context', () => ({
  resolveBookingExpertDisplay: (...args: unknown[]) => mockResolveBookingExpertDisplay(...args),
}));
vi.mock('@balo/db', () => ({
  requestExpertRelationshipsRepository: {
    stampAvailabilityShared: (...args: unknown[]) => mockStampAvailabilityShared(...args),
  },
  calendarRepository: {
    listConnectionsByExpertProfileId: (...args: unknown[]) =>
      mockListConnectionsByExpertProfileId(...args),
  },
}));

import { shareAvailabilityAction } from './share-availability';

const USER = { id: 'user-1', onboardingCompleted: true };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-4222-8222-222222222222';
const EXPERT_PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_USER_ID = '44444444-4444-4444-8444-444444444444';

const ACCESS_OK = {
  ok: true as const,
  ctx: { lens: 'expert' as const, archetype: 'participant' as const },
  request: {
    title: 'Salesforce CPQ rollout',
    createdByUserId: CLIENT_USER_ID,
    company: { name: 'Northwind Industrial' },
  },
  relationship: { id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID },
  conversationId: 'conversation-1',
  recipient: { role: 'client' as const, userId: CLIENT_USER_ID },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    relationshipId: RELATIONSHIP_ID,
    surface: 'header' as const,
    ...overrides,
  };
}

/**
 * The FULL published payload — every field the `conversation.availability_shared` Zod arm
 * requires. Asserted EXACTLY, never with `objectContaining` (round-1 W5): `objectContaining`
 * cannot catch a MISSING key, and `requestTitle` — a required field — was absent from the
 * original assertion, so payload drift would have shipped green and 400'd at runtime inside
 * the fire-and-forget publish.
 */
const EXPECTED_PAYLOAD = {
  correlationId: `${RELATIONSHIP_ID}--2026-08-25T00:00:00.000Z--0`,
  requestId: REQUEST_ID,
  requestTitle: 'Salesforce CPQ rollout',
  relationshipId: RELATIONSHIP_ID,
  recipientId: CLIENT_USER_ID,
  expertProfileId: EXPERT_PROFILE_ID,
  expertPersonName: 'Dana Okoro',
  expertPartyLabel: 'CloudPeak',
  sharedAtIso: '2026-08-25T00:00:00.000Z',
  previousSharedAtIso: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockResolveConversationAccess.mockResolvedValue(ACCESS_OK);
  mockHasExpertDeliveryCapability.mockResolvedValue(true);
  mockAssertRelationshipBookable.mockResolvedValue(true);
  mockListConnectionsByExpertProfileId.mockResolvedValue([{ credentialStatus: 'ACTIVE' }]);
  mockResolveBookingExpertDisplay.mockResolvedValue({
    firstName: 'Dana',
    lastName: 'Okoro',
    partyLabel: 'CloudPeak',
  });
  mockStampAvailabilityShared.mockResolvedValue({
    previousSharedAt: null,
    sharedAt: new Date('2026-08-25T00:00:00.000Z'),
  });
});

describe('shareAvailabilityAction', () => {
  it('first share: stamps, publishes the COMPLETE payload exactly, returns isReshare:false', async () => {
    const result = await shareAvailabilityAction(input());

    expect(result).toEqual({
      ok: true,
      isReshare: false,
      calendarConnected: true,
      sharedAtIso: '2026-08-25T00:00:00.000Z',
    });
    expect(mockStampAvailabilityShared).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'conversation.availability_shared',
      EXPECTED_PAYLOAD
    );
  });

  it('re-share: carries the previous instant, returns isReshare:true', async () => {
    mockStampAvailabilityShared.mockResolvedValue({
      previousSharedAt: new Date('2026-08-20T00:00:00.000Z'),
      sharedAt: new Date('2026-08-25T00:00:00.000Z'),
    });

    const result = await shareAvailabilityAction(input());

    expect(result).toEqual({
      ok: true,
      isReshare: true,
      calendarConnected: true,
      sharedAtIso: '2026-08-25T00:00:00.000Z',
    });
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith('conversation.availability_shared', {
      ...EXPECTED_PAYLOAD,
      correlationId: `${RELATIONSHIP_ID}--2026-08-25T00:00:00.000Z--${Date.parse('2026-08-20T00:00:00.000Z')}`,
      previousSharedAtIso: '2026-08-20T00:00:00.000Z',
    });
  });

  it('correlationId differs between two shares of the SAME relationship (the BullMQ-jobId hazard)', async () => {
    mockStampAvailabilityShared.mockResolvedValueOnce({
      previousSharedAt: null,
      sharedAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    await shareAvailabilityAction(input());
    const firstCorrelationId = mockPublishNotificationEvent.mock.calls[0]?.[1]?.correlationId;

    mockStampAvailabilityShared.mockResolvedValueOnce({
      previousSharedAt: new Date('2026-08-25T00:00:00.000Z'),
      sharedAt: new Date('2026-08-26T00:00:00.000Z'),
    });
    await shareAvailabilityAction(input());
    const secondCorrelationId = mockPublishNotificationEvent.mock.calls[1]?.[1]?.correlationId;

    expect(firstCorrelationId).not.toBe(secondCorrelationId);
  });

  /**
   * ⚠ MILLISECOND COLLISION (round-1 W13). `sharedAtIso` alone is ms-resolution, so two tabs
   * landing in the SAME millisecond minted an identical BullMQ jobId and the second publish was
   * silently dropped — the exact "per state, not per write" failure the key was written to
   * avoid. Including the PREDECESSOR makes the key a function of the TRANSITION.
   */
  it('correlationId still differs when two shares land in the SAME millisecond', async () => {
    const sameInstant = new Date('2026-08-25T00:00:00.000Z');
    mockStampAvailabilityShared.mockResolvedValueOnce({
      previousSharedAt: null,
      sharedAt: sameInstant,
    });
    await shareAvailabilityAction(input());

    mockStampAvailabilityShared.mockResolvedValueOnce({
      previousSharedAt: sameInstant,
      sharedAt: sameInstant,
    });
    await shareAvailabilityAction(input());

    expect(mockPublishNotificationEvent.mock.calls[0]?.[1]?.correlationId).not.toBe(
      mockPublishNotificationEvent.mock.calls[1]?.[1]?.correlationId
    );
  });

  it('calendarConnected is false when no ACTIVE connection exists — the share still succeeds', async () => {
    mockListConnectionsByExpertProfileId.mockResolvedValue([]);
    const result = await shareAvailabilityAction(input());
    expect(result).toMatchObject({ ok: true, isReshare: false, calendarConnected: false });
  });

  // ── Uncovered branches (round-1 W12) ────────────────────────────────────────────────────

  it('a calendar READ FAILURE degrades to calendarConnected:false — it never fails the share', async () => {
    mockListConnectionsByExpertProfileId.mockRejectedValue(new Error('apiroc down'));
    const result = await shareAvailabilityAction(input());
    expect(result).toMatchObject({ ok: true, calendarConnected: false });
    expect(mockPublishNotificationEvent).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  /**
   * ⚠ THE ONLY THING STOPPING A WITHDRAWN EXPERT'S SHARE FROM PUBLISHING. `stampAvailabilityShared`
   * returns `undefined` when the row moved (soft-deleted) between the access read and this
   * write — a TOCTOU window that `assertRelationshipBookable` cannot close because it runs
   * earlier.
   */
  it('not_permitted when the row is gone AT WRITE TIME — and nothing is published', async () => {
    mockStampAvailabilityShared.mockResolvedValue(undefined);
    await expect(shareAvailabilityAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it("'failed' (not a silent success) when a repository throws mid-flight", async () => {
    mockStampAvailabilityShared.mockRejectedValue(new Error('db down'));
    await expect(shareAvailabilityAction(input())).resolves.toEqual({ ok: false, code: 'failed' });
    expect(mockLogError).toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('falls back to "An expert" — matching load-booking-context, never "Your expert @ An expert"', async () => {
    mockResolveBookingExpertDisplay.mockResolvedValue({
      firstName: null,
      lastName: null,
      partyLabel: 'An expert',
    });
    await shareAvailabilityAction(input());
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith('conversation.availability_shared', {
      ...EXPECTED_PAYLOAD,
      expertPersonName: 'An expert',
      expertPartyLabel: 'An expert',
    });
  });

  it('not_permitted when un-onboarded', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));
    await expect(shareAvailabilityAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockStampAvailabilityShared).not.toHaveBeenCalled();
  });

  it('invalid_request on malformed input', async () => {
    await expect(shareAvailabilityAction(input({ requestId: 'not-a-uuid' }))).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
    });
    expect(mockStampAvailabilityShared).not.toHaveBeenCalled();
  });

  it('not_permitted when declined — no stamp, no publish', async () => {
    mockAssertRelationshipBookable.mockResolvedValue(false);
    await expect(shareAvailabilityAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(mockStampAvailabilityShared).not.toHaveBeenCalled();
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE GATE IS THE ENGAGEMENT AXIS, NOT `lens === 'expert'` (ADR-1029 / ADR-1046). CLAUDE.md
   * is categorical: `lens` gates the VIEW, a capability gates the MUTATION. These three tests
   * exist so a later lens widening (an agency-admin lens, a delegate, ADR-1029
   * `representations` / BAL-313) cannot inherit the right to write a column and email the
   * counterparty by accident.
   */
  describe('the delivery-identity gate (engagement axis)', () => {
    it('asks the ENGAGEMENT axis for MANAGE_ENGAGEMENT on the relationship’s expert profile', async () => {
      await shareAvailabilityAction(input());
      expect(mockHasExpertDeliveryCapability).toHaveBeenCalledWith(
        USER,
        'manage_engagement',
        EXPERT_PROFILE_ID,
        { contextType: 'request_interaction', contextId: RELATIONSHIP_ID }
      );
    });

    it('not_permitted when the actor is NOT on the delivery side — no stamp, no publish', async () => {
      mockHasExpertDeliveryCapability.mockResolvedValue(false);
      await expect(shareAvailabilityAction(input())).resolves.toEqual({
        ok: false,
        code: 'not_permitted',
      });
      expect(mockStampAvailabilityShared).not.toHaveBeenCalled();
      expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
    });

    it('a CLIENT-lens viewer is denied by the capability, not by the lens string', async () => {
      mockResolveConversationAccess.mockResolvedValue({
        ...ACCESS_OK,
        ctx: { lens: 'client' as const, archetype: 'participant' as const },
      });
      // A client-side actor holds no delivery identity — the axis says so on its own.
      mockHasExpertDeliveryCapability.mockResolvedValue(false);
      await expect(shareAvailabilityAction(input())).resolves.toEqual({
        ok: false,
        code: 'not_permitted',
      });
      expect(mockStampAvailabilityShared).not.toHaveBeenCalled();
    });

    it('the lens string is NOT consulted — an expert-side holder on a client lens still shares', async () => {
      // The regression this pins: if the gate were still `ctx.lens !== 'expert'`, a genuine
      // holder reaching this action under any other lens would be refused, and (worse) a
      // widened lens would be ADMITTED without holding the capability at all.
      mockResolveConversationAccess.mockResolvedValue({
        ...ACCESS_OK,
        ctx: { lens: 'client' as const, archetype: 'participant' as const },
      });
      mockHasExpertDeliveryCapability.mockResolvedValue(true);
      await expect(shareAvailabilityAction(input())).resolves.toMatchObject({ ok: true });
    });
  });

  it('not_permitted when conversation access is denied', async () => {
    mockResolveConversationAccess.mockResolvedValue({ ok: false, error: 'denied' });
    await expect(shareAvailabilityAction(input())).resolves.toEqual({
      ok: false,
      code: 'not_permitted',
    });
  });
});
