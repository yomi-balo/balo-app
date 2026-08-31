import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

const { mockGetCurrentUser, mockRedirect } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

import CompanySettingsPage from './company/page';
import NotificationsSettingsPage from './notifications/page';

/** Forbidden absence-framed / gendered phrasings — CLAUDE.md's Copy & Microcopy rule. */
const FORBIDDEN_PATTERNS = [
  /\bNo /i,
  /Nothing here/i,
  /Not available/i,
  /Coming soon/i,
  /\bhe\b/i,
  /\bshe\b/i,
  /\bhis\b/i,
  /\bher\b/i,
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', companyId: 'company-1' });
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
});

/**
 * ⚠ Renders the page BENEATH a stub `<h1>`, the way the real dashboard chrome does
 * (`breadcrumbs.tsx` renders the last crumb as the page `h1`). The isolated-component axe run in
 * `tab-placeholder.test.tsx` CANNOT catch a heading-order break, because a lone `h3` has no prior
 * heading to be out of order against — which is exactly how the original `h1 → h3` skip shipped.
 */
async function renderUnderChrome(ui: React.JSX.Element) {
  return render(
    <div>
      <h1>Company</h1>
      {ui}
    </div>
  );
}

describe('Company settings placeholder', () => {
  it('renders its title and description', async () => {
    render(await CompanySettingsPage());
    expect(screen.getByText('Your company profile')).toBeInTheDocument();
    expect(
      screen.getByText(/keep your company's name, logo, and web domains up to date/)
    ).toBeInTheDocument();
  });

  it('renders no h1 (the breadcrumb owns it)', async () => {
    render(await CompanySettingsPage());
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('copy avoids absence-framed and gendered phrasings', async () => {
    const { container } = render(await CompanySettingsPage());
    const text = container.textContent ?? '';
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });
});

describe('Notifications settings placeholder', () => {
  it('renders its title and description', async () => {
    render(await NotificationsSettingsPage());
    expect(screen.getByText('Your notification preferences')).toBeInTheDocument();
    expect(screen.getByText(/choose which updates reach you and how/)).toBeInTheDocument();
  });

  it('renders no h1 (the breadcrumb owns it)', async () => {
    render(await NotificationsSettingsPage());
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('copy avoids absence-framed and gendered phrasings', async () => {
    const { container } = render(await NotificationsSettingsPage());
    const text = container.textContent ?? '';
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });
});

describe('placeholder heading order under the real chrome', () => {
  it('Company: h1 → h2, no skipped level (axe heading-order)', async () => {
    const { container } = await renderUnderChrome(await CompanySettingsPage());
    expect(
      screen.getByRole('heading', { level: 2, name: 'Your company profile' })
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Notifications: h1 → h2, no skipped level (axe heading-order)', async () => {
    const { container } = await renderUnderChrome(await NotificationsSettingsPage());
    expect(
      screen.getByRole('heading', { level: 2, name: 'Your notification preferences' })
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
