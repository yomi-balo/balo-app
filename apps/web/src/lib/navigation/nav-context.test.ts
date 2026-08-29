import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CAPABILITIES, rolesWithCapability } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';

vi.mock('@balo/db', () => ({
  companiesRepository: { findById: vi.fn() },
}));

// `@/lib/logging` is globally mocked in `src/test/setup.ts`; `server-only` is aliased to a stub
// by `vitest.config.ts`.
import { companiesRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { buildNavContext } from './nav-context';

const findById = vi.mocked(companiesRepository.findById);

function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user_1',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company_1',
    companyName: 'Acme',
    companyRole: 'member',
    ...overrides,
  };
}

describe('buildNavContext (BAL-347 → BAL-495 equivalence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('user === null → company workspace, no capabilities', async () => {
    const context = await buildNavContext(null);
    expect(context).toEqual({ workspaceType: 'company', capabilities: [] });
    expect(findById).not.toHaveBeenCalled();
  });

  it('companyRole "member" → no capabilities, no DB read', async () => {
    const context = await buildNavContext(makeUser({ companyRole: 'member' }));
    expect(context.capabilities).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('companyRole "owner", company undefined → no capabilities', async () => {
    findById.mockResolvedValueOnce(undefined);
    const context = await buildNavContext(makeUser({ companyRole: 'owner' }));
    expect(context.capabilities).toEqual([]);
  });

  it('companyRole "owner", isPersonal true → no capabilities', async () => {
    findById.mockResolvedValueOnce({ id: 'company_1', isPersonal: true } as never);
    const context = await buildNavContext(makeUser({ companyRole: 'owner' }));
    expect(context.capabilities).toEqual([]);
  });

  it('companyRole "owner", isPersonal false → manage_members granted', async () => {
    findById.mockResolvedValueOnce({ id: 'company_1', isPersonal: false } as never);
    const context = await buildNavContext(makeUser({ companyRole: 'owner' }));
    expect(context.capabilities).toEqual([CAPABILITIES.MANAGE_MEMBERS]);
  });

  it('companyRole "admin", isPersonal false → manage_members granted', async () => {
    findById.mockResolvedValueOnce({ id: 'company_1', isPersonal: false } as never);
    const context = await buildNavContext(makeUser({ companyRole: 'admin' }));
    expect(context.capabilities).toEqual([CAPABILITIES.MANAGE_MEMBERS]);
  });

  it('findById throws → warns with the exact preserved message and returns no capabilities', async () => {
    findById.mockRejectedValueOnce(new Error('db unreachable'));
    const user = makeUser({ companyRole: 'owner' });
    const context = await buildNavContext(user);

    expect(context.capabilities).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Failed to resolve company for nav gating', {
      userId: user.id,
      error: 'db unreachable',
    });
  });

  it('unknown role string (stale cookie) → no capabilities, no DB read', async () => {
    const context = await buildNavContext(
      makeUser({ companyRole: 'legacy_role' as SessionUser['companyRole'] })
    );
    expect(context.capabilities).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('rolesWithCapability(MANAGE_MEMBERS) equals [owner, admin] — the substitution proof', () => {
    expect(rolesWithCapability(CAPABILITIES.MANAGE_MEMBERS)).toEqual(['owner', 'admin']);
  });

  it('workspaceType is "expert" iff activeMode is "expert"; "company" for client and for null', async () => {
    expect((await buildNavContext(makeUser({ activeMode: 'expert' }))).workspaceType).toBe(
      'expert'
    );
    expect((await buildNavContext(makeUser({ activeMode: 'client' }))).workspaceType).toBe(
      'company'
    );
    expect((await buildNavContext(null)).workspaceType).toBe('company');
  });
});
