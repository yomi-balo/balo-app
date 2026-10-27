import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

const { hasExpertDeliveryCapability } = vi.hoisted(() => ({
  hasExpertDeliveryCapability: vi.fn(),
}));
vi.mock('@/lib/authz/engagement', () => ({ hasExpertDeliveryCapability }));

import {
  resolveEngagementViewer,
  resolveExpertSideActor,
  timeEntryAuthorScope,
} from './resolve-engagement-viewer';

const CLIENT_COMPANY = 'company-northwind';
const EXPERT_PROFILE = 'expert-priya';
const engagement = { id: 'eng-1', companyId: CLIENT_COMPANY, expertProfileId: EXPERT_PROFILE };

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Charles',
    lastName: 'Admin',
    avatarUrl: null,
    activeMode: 'expert',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-other',
    companyName: 'Other Co',
    companyRole: 'member',
    ...over,
  };
}

beforeEach(() => {
  hasExpertDeliveryCapability.mockReset();
});

describe('resolveExpertSideActor', () => {
  it('asks the manage_engagement capability for the delivering expert profile and the project context', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);
    const user = makeUser();

    await resolveExpertSideActor(user, engagement);

    expect(hasExpertDeliveryCapability).toHaveBeenCalledWith(
      user,
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      EXPERT_PROFILE,
      { contextType: 'project', contextId: 'eng-1' }
    );
  });

  it('classifies the delivering expert', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    const actor = await resolveExpertSideActor(
      makeUser({ expertProfileId: EXPERT_PROFILE }),
      engagement
    );

    expect(actor).toEqual({ isDeliveringExpert: true, actingAs: 'delivering_expert' });
  });

  it('classifies a holder with another expert profile as an agency admin', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    const actor = await resolveExpertSideActor(
      makeUser({ expertProfileId: 'expert-other' }),
      engagement
    );

    expect(actor).toEqual({ isDeliveringExpert: false, actingAs: 'agency_admin' });
  });

  it('classifies a holder with no expert profile as an agency admin', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    expect(await resolveExpertSideActor(makeUser(), engagement)).toEqual({
      isDeliveringExpert: false,
      actingAs: 'agency_admin',
    });
  });

  it('returns null when the capability is not held', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(false);

    expect(await resolveExpertSideActor(makeUser(), engagement)).toBeNull();
  });
});

describe('resolveEngagementViewer', () => {
  it.each([
    ['client', makeUser({ companyId: CLIENT_COMPANY }), 'client'],
    ['expert', makeUser({ expertProfileId: EXPERT_PROFILE }), 'expert'],
    ['admin', makeUser({ platformRole: 'admin' }), 'admin'],
  ])('returns the %s lens untouched without asking the capability', async (_name, user, lens) => {
    const ctx = await resolveEngagementViewer(user, engagement);

    expect(ctx?.lens).toBe(lens);
    expect(hasExpertDeliveryCapability).not.toHaveBeenCalled();
  });

  it('gives an agency owner/admin the expert presentation without delivering identity', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    const ctx = await resolveEngagementViewer(makeUser(), engagement);

    expect(ctx).toEqual({
      lens: 'expert',
      archetype: 'participant',
      isClientOwner: false,
      isDeliveringExpert: false,
    });
    expect(hasExpertDeliveryCapability).toHaveBeenCalledTimes(1);
  });

  it('returns null for a stranger who holds no capability', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(false);

    expect(await resolveEngagementViewer(makeUser(), engagement)).toBeNull();
  });
});

describe('timeEntryAuthorScope', () => {
  it('keeps the delivering expert to their own entries and lets anyone else reach any', () => {
    expect(timeEntryAuthorScope(true)).toBe('own');
    expect(timeEntryAuthorScope(false)).toBe('any');
  });
});
