import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { toMarketingViewer } from '@/components/marketing/marketing-viewer';
import ApplyLayout from './layout';

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));

// BAL-502 FIX round — `ApplyHeaderActions` is stubbed so this file tests what the LAYOUT
// actually PASSES DOWN, not what the (separately tested) real component renders. Same rationale
// as `(marketing)/layout.test.tsx`: a real component renders none of its `viewer` prop's raw
// source (`SessionUser`) as text, so an `container.innerHTML` assertion against the real
// component cannot catch a future `viewer={user}`-shaped regression. Surfacing the prop as text
// — the pattern `(apply)/expert/apply/page.test.tsx` already uses for
// `ExpertApplicationWizard` — makes that regression actually fail this test.
vi.mock('./_components/apply-header-actions', () => ({
  ApplyHeaderActions: ({ viewer }: { viewer: ReturnType<typeof toMarketingViewer> }) => (
    <div data-testid="apply-header-actions">{viewer ? JSON.stringify(viewer) : 'null'}</div>
  ),
}));

function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-secret-id',
    email: 'dana@northwind.example',
    firstName: 'Dana',
    lastName: 'Okafor',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-secret-id',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    expertProfileId: 'expert-profile-secret-id',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApplyLayout — anonymous', () => {
  it('renders children and passes a null viewer to ApplyHeaderActions', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const ui = await ApplyLayout({ children: <p>Wizard</p> });
    render(ui);

    expect(screen.getByText('Wizard')).toBeInTheDocument();
    expect(screen.getByTestId('apply-header-actions')).toHaveTextContent('null');
  });
});

describe('ApplyLayout — signed in', () => {
  it('renders children and passes the projected viewer (display fields only)', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await ApplyLayout({ children: <p>Wizard</p> });
    render(ui);

    expect(screen.getByText('Wizard')).toBeInTheDocument();
    const passed = JSON.parse(screen.getByTestId('apply-header-actions').textContent ?? 'null');
    expect(passed).toEqual({ displayName: 'Dana Okafor', initials: 'DO', avatarUrl: null });
  });
});

describe('ApplyLayout — session read failure', () => {
  it('degrades to a null viewer, still renders children, and logs a warning', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('WORKOS_COOKIE_PASSWORD missing'));
    const ui = await ApplyLayout({ children: <p>Wizard</p> });
    render(ui);

    expect(screen.getByText('Wizard')).toBeInTheDocument();
    expect(screen.getByTestId('apply-header-actions')).toHaveTextContent('null');
    expect(log.warn).toHaveBeenCalledWith(
      'Apply layout session read failed; rendering the signed-out header',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('ApplyLayout — the anti-PII-leak regression guard', () => {
  it('never passes id, email, companyId, platformRole, or expertProfileId to ApplyHeaderActions', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await ApplyLayout({ children: <p>Wizard</p> });
    const { container } = render(ui);

    expect(container.innerHTML).not.toContain('user-secret-id');
    expect(container.innerHTML).not.toContain('dana@northwind.example');
    expect(container.innerHTML).not.toContain('company-secret-id');
    expect(container.innerHTML).not.toContain('platformRole');
    expect(container.innerHTML).not.toContain('expert-profile-secret-id');
  });

  // A direct pin against field creep on the projection itself, independent of the layout
  // wiring above — see `(marketing)/layout.test.tsx` for the twin assertion.
  it('toMarketingViewer projects EXACTLY displayName, initials, and avatarUrl', () => {
    const viewer = toMarketingViewer(makeSessionUser());
    expect(viewer).not.toBeNull();
    expect(Object.keys(viewer ?? {})).toEqual(['displayName', 'initials', 'avatarUrl']);
  });
});
