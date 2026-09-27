import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClientPartyIdentities, mockFindUserIdByProfileId } = vi.hoisted(() => ({
  mockClientPartyIdentities: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingPresenceRepository: { clientPartyIdentities: mockClientPartyIdentities },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
}));

import {
  expertInvitedGuestGuard,
  onlyExpertInvitedGuestsAttended,
} from './expert-invited-guest-guard.js';

const MEETING_ID = 'meeting-1';
const EXPERT_PROFILE_ID = 'expert-1';
const SUBJECT = {
  engagementId: 'engagement-1',
  companyId: 'company-1',
  expertProfileId: EXPERT_PROFILE_ID,
  isActive: true,
  closedAt: null,
  closedByUserId: null,
};

describe('onlyExpertInvitedGuestsAttended (BAL-474, D5.9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: 'expert-user-1' } });
  });

  it('is TRUE only when no client-party member was present and every client-party guest was invited by the delivering expert', async () => {
    mockClientPartyIdentities.mockResolvedValue({
      memberUserIds: [],
      guestInviterIds: ['expert-user-1', 'expert-user-1'],
    });
    await expect(onlyExpertInvitedGuestsAttended(MEETING_ID, EXPERT_PROFILE_ID)).resolves.toBe(
      true
    );
    expect(mockFindUserIdByProfileId).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  it.each([
    [
      'a client MEMBER was present',
      { memberUserIds: ['member-1'], guestInviterIds: ['expert-user-1'] },
    ],
    ['no client-party guest was present', { memberUserIds: [], guestInviterIds: [] }],
    [
      'ONE guest was invited by someone else',
      { memberUserIds: [], guestInviterIds: ['expert-user-1', 'booker-1'] },
    ],
    ['a guest has no inviter', { memberUserIds: [], guestInviterIds: [null] }],
  ])('is FALSE when %s — the call is billed', async (_label, identities) => {
    mockClientPartyIdentities.mockResolvedValue(identities);
    await expect(onlyExpertInvitedGuestsAttended(MEETING_ID, EXPERT_PROFILE_ID)).resolves.toBe(
      false
    );
  });

  it('fails CLOSED toward billing when the delivering expert has no user', async () => {
    mockClientPartyIdentities.mockResolvedValue({ memberUserIds: [], guestInviterIds: ['x'] });
    mockFindUserIdByProfileId.mockResolvedValue(undefined);
    await expect(onlyExpertInvitedGuestsAttended(MEETING_ID, EXPERT_PROFILE_ID)).resolves.toBe(
      false
    );
  });

  it('does not look the expert up when the presence already settles it (a member is present)', async () => {
    mockClientPartyIdentities.mockResolvedValue({ memberUserIds: ['m'], guestInviterIds: ['g'] });
    await onlyExpertInvitedGuestsAttended(MEETING_ID, EXPERT_PROFILE_ID);
    expect(mockFindUserIdByProfileId).not.toHaveBeenCalled();
  });
});

describe('expertInvitedGuestGuard — the `guard` resolveOnBehalfOpenInput takes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: 'expert-user-1' } });
  });

  it('answers `expert_invited_guest` for the subject’s own expert when only their guests attended', async () => {
    mockClientPartyIdentities.mockResolvedValue({
      memberUserIds: [],
      guestInviterIds: ['expert-user-1'],
    });
    await expect(expertInvitedGuestGuard(MEETING_ID)(SUBJECT)).resolves.toBe(
      'expert_invited_guest'
    );
    expect(mockClientPartyIdentities).toHaveBeenCalledWith(MEETING_ID);
  });

  it('answers undefined otherwise', async () => {
    mockClientPartyIdentities.mockResolvedValue({ memberUserIds: ['m'], guestInviterIds: [] });
    await expect(expertInvitedGuestGuard(MEETING_ID)(SUBJECT)).resolves.toBeUndefined();
  });
});
