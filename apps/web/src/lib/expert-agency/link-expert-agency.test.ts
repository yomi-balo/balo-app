import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// @balo/db repos mocked; @balo/shared/domains is REAL; the resolver is REAL (driven
// via the mocked db reads); `@/lib/logging` is globally mocked in test/setup.ts.

const {
  mockFindProfileById,
  mockFindActiveByDomain,
  mockGetSummaryById,
  mockJoinExisting,
  mockProvision,
  mockProvisionSolo,
} = vi.hoisted(() => ({
  mockFindProfileById: vi.fn(),
  mockFindActiveByDomain: vi.fn(),
  mockGetSummaryById: vi.fn(),
  mockJoinExisting: vi.fn(),
  mockProvision: vi.fn(),
  mockProvisionSolo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findProfileById: mockFindProfileById },
  partyDomainsRepository: { findActiveByDomain: mockFindActiveByDomain },
  agenciesRepository: {
    getSummaryById: mockGetSummaryById,
    joinExisting: mockJoinExisting,
    provision: mockProvision,
    provisionSolo: mockProvisionSolo,
  },
}));

const mockPublish = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import {
  runLinkExpertAgency,
  publishAgencyResolutionNotifications,
  type LinkResult,
} from './link-expert-agency';

// ── Helpers ─────────────────────────────────────────────────────

const CORP_EMAIL = 'newhire@acme.io';
const FREEMAIL = 'jane@gmail.com';
const PROFILE_ID = 'profile-1';
const USER_ID = 'user-1';

function baseInput(over: Partial<Parameters<typeof runLinkExpertAgency>[0]> = {}) {
  return {
    userId: USER_ID,
    email: CORP_EMAIL,
    firstName: 'Jane',
    lastName: 'Doe',
    expertProfileId: PROFILE_ID,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── runLinkExpertAgency ─────────────────────────────────────────

describe('runLinkExpertAgency', () => {
  it('is idempotent: an already-linked profile is a no-op (no second agency, no write)', async () => {
    mockFindProfileById.mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      agencyId: 'agency-9',
    });

    const result = await runLinkExpertAgency(baseInput());

    expect(result).toEqual({ outcome: 'already_linked', agencyId: 'agency-9', fresh: false });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expect(mockJoinExisting).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockProvisionSolo).not.toHaveBeenCalled();
  });

  it('JOIN (fresh): joins the domain-owning agency and reports fresh + membershipId', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    mockGetSummaryById.mockResolvedValue({ id: 'agency-1', name: 'Lattice', memberCount: 4 });
    mockJoinExisting.mockResolvedValue({
      outcome: 'joined',
      membershipId: 'mem-1',
      agencyId: 'agency-1',
    });

    const result = await runLinkExpertAgency(baseInput());

    expect(result).toEqual({
      outcome: 'join',
      agencyId: 'agency-1',
      fresh: true,
      membershipId: 'mem-1',
    });
    expect(mockJoinExisting).toHaveBeenCalledWith({
      agencyId: 'agency-1',
      userId: USER_ID,
      expertProfileId: PROFILE_ID,
      actorUserId: USER_ID,
    });
  });

  it('JOIN (already_member): reports fresh=false on a resume', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    mockGetSummaryById.mockResolvedValue({ id: 'agency-1', name: 'Lattice', memberCount: 4 });
    mockJoinExisting.mockResolvedValue({
      outcome: 'already_member',
      membershipId: 'mem-1',
      agencyId: 'agency-1',
    });

    const result = await runLinkExpertAgency(baseInput());

    expect(result.fresh).toBe(false);
    expect(result.outcome).toBe('join');
  });

  it('PROVISION: creates a new agency for an unowned corporate domain', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockFindActiveByDomain.mockResolvedValue(undefined);
    mockProvision.mockResolvedValue({ agencyId: 'agency-new', ownerMembershipId: 'own-1' });

    const result = await runLinkExpertAgency(baseInput());

    expect(result).toEqual({ outcome: 'provision', agencyId: 'agency-new', fresh: true });
    expect(mockProvision).toHaveBeenCalledWith({
      name: 'Acme', // suggested from acme.io
      domain: 'acme.io',
      userId: USER_ID,
      expertProfileId: PROFILE_ID,
      actorUserId: USER_ID,
    });
  });

  it('SOLO: creates an agency-of-one named from the signer (freemail → independent)', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockProvisionSolo.mockResolvedValue({ agencyId: 'agency-solo', ownerMembershipId: 'own-1' });

    const result = await runLinkExpertAgency(baseInput({ email: FREEMAIL }));

    expect(result).toEqual({ outcome: 'solo', agencyId: 'agency-solo', fresh: true });
    expect(mockProvisionSolo).toHaveBeenCalledWith({
      name: 'Jane Doe',
      userId: USER_ID,
      expertProfileId: PROFILE_ID,
      actorUserId: USER_ID,
    });
    // Never touches the domain owner lookup on the freemail path.
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('SOLO: falls back to "Independent Expert" when the signer has no name', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockProvisionSolo.mockResolvedValue({ agencyId: 'agency-solo', ownerMembershipId: 'own-1' });

    await runLinkExpertAgency(baseInput({ email: FREEMAIL, firstName: null, lastName: null }));

    expect(mockProvisionSolo).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Independent Expert' })
    );
  });

  it('surfaces a provision write error (lost capture race) to the caller', async () => {
    mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
    mockFindActiveByDomain.mockResolvedValue(undefined);
    mockProvision.mockRejectedValue(new Error('capture conflict'));

    await expect(runLinkExpertAgency(baseInput())).rejects.toThrow('capture conflict');
  });
});

// ── publishAgencyResolutionNotifications ─────────────────────────

describe('publishAgencyResolutionNotifications', () => {
  it('publishes party.member_joined_via_domain for a fresh JOIN', async () => {
    const result: LinkResult = {
      outcome: 'join',
      agencyId: 'agency-1',
      fresh: true,
      membershipId: 'mem-1',
    };
    await publishAgencyResolutionNotifications(result, USER_ID);
    expect(mockPublish).toHaveBeenCalledWith('party.member_joined_via_domain', {
      correlationId: 'mem-1',
      partyType: 'agency',
      partyId: 'agency-1',
      userId: USER_ID,
    });
  });

  it('publishes agency.provisioned for a PROVISION', async () => {
    const result: LinkResult = { outcome: 'provision', agencyId: 'agency-new', fresh: true };
    await publishAgencyResolutionNotifications(result, USER_ID);
    expect(mockPublish).toHaveBeenCalledWith('agency.provisioned', {
      correlationId: 'agency-new',
      agencyId: 'agency-new',
      ownerUserId: USER_ID,
    });
  });

  it('publishes NOTHING for SOLO (never says "agency")', async () => {
    const result: LinkResult = { outcome: 'solo', agencyId: 'agency-solo', fresh: true };
    await publishAgencyResolutionNotifications(result, USER_ID);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes NOTHING for an already_linked no-op', async () => {
    const result: LinkResult = { outcome: 'already_linked', agencyId: 'agency-9', fresh: false };
    await publishAgencyResolutionNotifications(result, USER_ID);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('swallows a publish failure (a notification hiccup never fails the committed write)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('publish down'));
    const result: LinkResult = { outcome: 'provision', agencyId: 'agency-new', fresh: true };
    await expect(publishAgencyResolutionNotifications(result, USER_ID)).resolves.toBeUndefined();
  });
});
