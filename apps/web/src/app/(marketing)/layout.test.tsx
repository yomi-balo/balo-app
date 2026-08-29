import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { toMarketingViewer } from '@/components/marketing/marketing-viewer';
import MarketingLayout from './layout';
import MarketingError from './error';

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));

// BAL-502 FIX round — `MarketingHeader` is stubbed so this file tests what the LAYOUT actually
// PASSES DOWN, not what the (separately, thoroughly tested in `marketing-header.test.tsx`) real
// header renders. This is the load-bearing part of the anti-PII-leak guard below: a real header
// renders none of its `viewer` prop's raw source (`SessionUser`) as text, so asserting on
// `container.innerHTML` against a REAL header proves nothing about what was passed in — only
// about what the (already-safe) header chooses to display. Surfacing the prop as text, the same
// pattern `(apply)/expert/apply/page.test.tsx` uses for `ExpertApplicationWizard`, makes a
// regression where the layout starts passing the raw session user actually fail this test.
vi.mock('@/components/marketing/marketing-header', () => ({
  MarketingHeader: ({ viewer }: { viewer: ReturnType<typeof toMarketingViewer> }) => (
    <div data-testid="marketing-header">{viewer ? JSON.stringify(viewer) : 'null'}</div>
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

describe('MarketingLayout — signed out', () => {
  it('renders children and passes a null viewer to the header', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByTestId('marketing-header')).toHaveTextContent('null');
  });
});

describe('MarketingLayout — signed in', () => {
  it('renders children and passes the projected viewer (display fields only) to the header', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    const passed = JSON.parse(screen.getByTestId('marketing-header').textContent ?? 'null');
    expect(passed).toEqual({ displayName: 'Dana Okafor', initials: 'DO', avatarUrl: null });
  });
});

describe('MarketingLayout — session read failure', () => {
  it('degrades to a null viewer, still renders children, and logs a warning', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('WORKOS_COOKIE_PASSWORD missing'));
    const ui = await MarketingLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByTestId('marketing-header')).toHaveTextContent('null');
    expect(log.warn).toHaveBeenCalledWith(
      'Marketing layout session read failed; rendering the signed-out header',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('MarketingLayout — the anti-PII-leak regression guard', () => {
  it('never passes id, email, companyId, platformRole, or expertProfileId to the header', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());
    const ui = await MarketingLayout({ children: <p>Body</p> });
    const { container } = render(ui);

    expect(container.innerHTML).not.toContain('user-secret-id');
    expect(container.innerHTML).not.toContain('dana@northwind.example');
    expect(container.innerHTML).not.toContain('company-secret-id');
    expect(container.innerHTML).not.toContain('platformRole');
    expect(container.innerHTML).not.toContain('expert-profile-secret-id');
  });

  // A direct pin against field creep on the projection itself — independent of the layout
  // wiring above. Adding a field to `MarketingViewer` (or accidentally widening
  // `MarketingViewerSource`) without updating this test is the signal that a reviewer should
  // treat as an information-disclosure decision, per `marketing-viewer.ts`'s own warning.
  it('toMarketingViewer projects EXACTLY displayName, initials, and avatarUrl', () => {
    const viewer = toMarketingViewer(makeSessionUser());
    expect(viewer).not.toBeNull();
    expect(Object.keys(viewer ?? {})).toEqual(['displayName', 'initials', 'avatarUrl']);
  });
});

describe('(marketing)/error.tsx', () => {
  it('renders the fallback and calls reset on Try again', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<MarketingError error={new Error('boom')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
