import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import type { PlatformConfigAdminDTO } from '@/lib/platform-config/platform-config-admin';

// ── Seams the page composes (mirrors the promo-codes RSC page-test precedent) ──
const { mockGetCurrentUser, mockIsPlatformAdmin, mockRedirect, mockNotFound, mockLoad } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockIsPlatformAdmin: vi.fn(),
    mockRedirect: vi.fn(() => {
      throw new Error('NEXT_REDIRECT');
    }),
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    mockLoad: vi.fn(),
  }));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/auth/is-admin', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock('@/lib/platform-config/platform-config-admin', () => ({
  loadPlatformConfigAdmin: mockLoad,
}));
// Stub the heavy client form — this stays a unit test of the page's gating.
vi.mock('./_components/platform-config-form', () => ({
  PlatformConfigForm: ({ dto }: { dto: PlatformConfigAdminDTO }) => (
    <div data-testid="config-form" data-min={String(dto.minConsultationMinutes)} />
  ),
}));

// `@/lib/logging` is globally mocked in test/setup — grab the mocked `log` to assert on it.
import { log } from '@/lib/logging';
import PlatformConfigPage from './page';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
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

function dto(minConsultationMinutes = 15): PlatformConfigAdminDTO {
  return { minConsultationMinutes, billingFloorMinutes: 15 };
}

async function renderPage(): Promise<ReturnType<typeof render>> {
  const ui = await PlatformConfigPage();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlatformConfigPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user (and loads nothing)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('notFound() for a non-admin viewer (no existence leak; loads nothing)', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    mockIsPlatformAdmin.mockReturnValue(false);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(screen.queryByTestId('config-form')).not.toBeInTheDocument();
  });
});

describe('PlatformConfigPage (RSC) — admin load', () => {
  it('loads the DTO and renders the form for an admin', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockIsPlatformAdmin.mockReturnValue(true);
    mockLoad.mockResolvedValue(dto(30));
    await renderPage();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('config-form')).toHaveAttribute('data-min', '30');
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('PlatformConfigPage (RSC) — load error boundary', () => {
  it('logs an error with {userId} and rethrows (to error.tsx) when the load throws', async () => {
    const viewer = user({ platformRole: 'admin' });
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockIsPlatformAdmin.mockReturnValue(true);
    mockLoad.mockRejectedValue(new Error('db down'));
    await expect(renderPage()).rejects.toThrow('db down');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load platform config',
      expect.objectContaining({ userId: viewer.id })
    );
    expect(screen.queryByTestId('config-form')).not.toBeInTheDocument();
  });
});
