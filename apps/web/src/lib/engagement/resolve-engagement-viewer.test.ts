import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

const { hasExpertDeliveryCapability, administersDeliveringAgency } = vi.hoisted(() => ({
  hasExpertDeliveryCapability: vi.fn(),
  administersDeliveringAgency: vi.fn(),
}));
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability,
  administersDeliveringAgency,
}));

import {
  resolveEngagementViewer,
  resolveExpertSideActor,
  resolveWorkspaceAccess,
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
  administersDeliveringAgency.mockReset();
  administersDeliveringAgency.mockResolvedValue(false);
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

describe('resolveWorkspaceAccess', () => {
  const tmActive = { ...engagement, pricingMethod: 'tm', status: 'active' };

  it('lets an agency owner/admin manage any entry but not log time, acting as agency_admin', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);
    administersDeliveringAgency.mockResolvedValue(true);

    const access = await resolveWorkspaceAccess(makeUser(), tmActive);

    expect(access).toEqual({
      ctx: {
        lens: 'expert',
        archetype: 'participant',
        isClientOwner: false,
        isDeliveringExpert: false,
      },
      canLogTime: false,
      timeEntryScope: 'any',
      actingAs: 'agency_admin',
    });
    expect(hasExpertDeliveryCapability).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-delivering actor the host context does not show as an administrator to their own entries', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    const access = await resolveWorkspaceAccess(makeUser(), tmActive);

    expect(access).toMatchObject({ timeEntryScope: 'own', actingAs: 'agency_admin' });
  });

  it('lets the delivering expert log time and keeps a role-expert deliverer to their own entries', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);

    const access = await resolveWorkspaceAccess(
      makeUser({ expertProfileId: EXPERT_PROFILE }),
      tmActive
    );

    expect(access).toMatchObject({
      canLogTime: true,
      timeEntryScope: 'own',
      actingAs: 'delivering_expert',
    });
    expect(access?.ctx.lens).toBe('expert');
  });

  it('gives a delivering expert who administers the agency any entry', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(true);
    administersDeliveringAgency.mockResolvedValue(true);

    const access = await resolveWorkspaceAccess(
      makeUser({ expertProfileId: EXPERT_PROFILE }),
      tmActive
    );

    expect(access).toMatchObject({ canLogTime: true, timeEntryScope: 'any' });
  });

  it('withholds logging and entry management from a party without the capability', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(false);

    const access = await resolveWorkspaceAccess(makeUser({ companyId: CLIENT_COMPANY }), tmActive);

    expect(access).toMatchObject({ canLogTime: false, timeEntryScope: null, actingAs: null });
    expect(access?.ctx.lens).toBe('client');
  });

  it.each([
    ['a fixed-price project', { pricingMethod: 'fixed', status: 'active' }],
    ['a T&M project under review', { pricingMethod: 'tm', status: 'pending_acceptance' }],
  ])('never asks the capability of a party on %s', async (_name, over) => {
    const access = await resolveWorkspaceAccess(makeUser({ expertProfileId: EXPERT_PROFILE }), {
      ...engagement,
      ...over,
    });

    expect(access).toMatchObject({
      canLogTime: false,
      timeEntryScope: null,
      actingAs: 'delivering_expert',
    });
    expect(hasExpertDeliveryCapability).not.toHaveBeenCalled();
  });

  it('reports no acting capacity for an observer', async () => {
    const access = await resolveWorkspaceAccess(makeUser({ platformRole: 'admin' }), tmActive);

    expect(access?.actingAs).toBeNull();
  });

  it('returns null for a stranger who holds no capability', async () => {
    hasExpertDeliveryCapability.mockResolvedValue(false);

    expect(await resolveWorkspaceAccess(makeUser(), tmActive)).toBeNull();
    expect(hasExpertDeliveryCapability).toHaveBeenCalledTimes(1);
  });
});

describe('timeEntryAuthorScope', () => {
  it.each([
    ['administers the delivering agency (owner/admin, or a delivering owner)', true, 'any'],
    ['does not (role-expert or independent deliverer, stale non-delivering actor)', false, 'own'],
  ])('actor who %s -> %s', async (_name, administers, expected) => {
    administersDeliveringAgency.mockResolvedValue(administers);

    expect(await timeEntryAuthorScope(makeUser(), engagement)).toBe(expected);
    expect(administersDeliveringAgency).toHaveBeenCalledTimes(1);
  });
});
