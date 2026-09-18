import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockListStaffAccessRoster } = vi.hoisted(() => ({
  mockListStaffAccessRoster: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  usersRepository: { listStaffAccessRoster: () => mockListStaffAccessRoster() },
}));

import type { SessionUser } from '@/lib/auth/session';
import { loadStaffAccess } from './load-staff-access';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

const PEOPLE = [
  {
    id: 'u1',
    firstName: 'Dana',
    lastName: 'Whitfield',
    email: 'dana@example.com',
    role: 'admin' as const,
    customList: null,
    isLive: true,
    emailVerified: true,
  },
];

const MANAGER = user({ id: 'u1', platformRole: 'super_admin' });
const NON_MANAGER = user({ id: 'u2', platformRole: 'admin' });

beforeEach(() => {
  vi.clearAllMocks();
  mockListStaffAccessRoster.mockResolvedValue(PEOPLE);
});

describe('loadStaffAccess', () => {
  it('returns forbidden with ZERO repository calls for a staff member without manage_staff_capabilities', async () => {
    const result = await loadStaffAccess(NON_MANAGER);
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockListStaffAccessRoster).not.toHaveBeenCalled();
  });

  it('returns the roster for a holder of manage_staff_capabilities', async () => {
    const result = await loadStaffAccess(MANAGER);
    expect(result).toEqual({ ok: true, people: PEOPLE });
    expect(mockListStaffAccessRoster).toHaveBeenCalledTimes(1);
  });
});
