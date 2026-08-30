import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const { mockNavWorkspaceTypeOf, mockHasCapability, mockFindById } = vi.hoisted(() => ({
  mockNavWorkspaceTypeOf: vi.fn(),
  mockHasCapability: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { findById: mockFindById },
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: mockHasCapability,
  CAPABILITIES: { MANAGE_MEMBERS: 'manage_members' },
}));
vi.mock('@/lib/navigation/nav-context', () => ({
  navWorkspaceTypeOf: mockNavWorkspaceTypeOf,
}));

import { resolveSettingsChrome } from './resolve-settings-chrome';

const USER = { id: 'user-1', companyId: 'company-1' } as SessionUser;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSettingsChrome', () => {
  it('company + capable + non-personal → showSectionNav true, showTeamSection true', async () => {
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({ id: 'company-1', isPersonal: false });

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: true,
      showTeamSection: true,
    });
  });

  it('company + capable + personal → showTeamSection false', async () => {
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({ id: 'company-1', isPersonal: true });

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: true,
      showTeamSection: false,
    });
  });

  it('company + not capable → showTeamSection false', async () => {
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockHasCapability.mockResolvedValue(false);
    mockFindById.mockResolvedValue({ id: 'company-1', isPersonal: false });

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: true,
      showTeamSection: false,
    });
  });

  it('company + a MISSING company row → showTeamSection false', async () => {
    // The `company !== undefined` arm of the conjunction. A deleted/missing row is exactly the
    // case where failing OPEN would be worst, and SonarCloud counts uncovered conditions.
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue(undefined);

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: true,
      showTeamSection: false,
    });
  });

  it('expert workspace → showSectionNav false, and NO database read is made', async () => {
    // ⚠ The expert branch returns before the reads. `team` is expert-scoped after BAL-503, so
    // `/settings/team` is precisely where expert traffic lands — resolving a `showTeamSection`
    // nothing renders would be pure waste on the hottest expert path.
    mockNavWorkspaceTypeOf.mockReturnValue('expert');

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: false,
      showTeamSection: false,
    });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('a repo throw fails closed: log.error is called and showTeamSection is false, showSectionNav is preserved', async () => {
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockHasCapability.mockRejectedValue(new Error('db down'));
    mockFindById.mockResolvedValue({ id: 'company-1', isPersonal: false });

    await expect(resolveSettingsChrome(USER)).resolves.toEqual({
      showSectionNav: true,
      showTeamSection: false,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to resolve settings chrome',
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    );
  });
});
