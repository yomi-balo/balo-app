import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

vi.mock('server-only', () => ({}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authz')>('@/lib/authz');
  return { ...actual, hasCapability: (...a: unknown[]) => mockHasCapability(...a) };
});

const mockHasEngagementCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: (...a: unknown[]) => mockHasEngagementCapability(...a),
}));

import { CAPABILITIES } from '@/lib/authz';
import { mayToggleCaseActionItems } from './may-toggle-case-action-items';

const ACTOR = { id: 'u-1' };
const SUBJECT = { engagementId: 'e-1', companyId: 'c-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockResolvedValue(true);
  mockHasEngagementCapability.mockResolvedValue(true);
});

describe('mayToggleCaseActionItems — each lens on its own axis', () => {
  it('client → MEMBERSHIP participate on the case company, never the engagement axis', async () => {
    expect(await mayToggleCaseActionItems(ACTOR, { ...SUBJECT, lens: 'client' })).toBe(true);
    expect(mockHasCapability).toHaveBeenCalledWith(ACTOR, CAPABILITIES.PARTICIPATE, {
      companyId: 'c-1',
    });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('expert → ENGAGEMENT manage_engagement on the case context, never the membership axis', async () => {
    expect(await mayToggleCaseActionItems(ACTOR, { ...SUBJECT, lens: 'expert' })).toBe(true);
    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      ACTOR,
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      { contextType: 'case', contextId: 'e-1' }
    );
    expect(mockHasCapability).not.toHaveBeenCalled();
  });

  it.each(['client', 'expert'] as const)('honours a false answer on the %s lens', async (lens) => {
    mockHasCapability.mockResolvedValue(false);
    mockHasEngagementCapability.mockResolvedValue(false);
    expect(await mayToggleCaseActionItems(ACTOR, { ...SUBJECT, lens })).toBe(false);
  });
});
