import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockGetCurrentUser, mockResolveSettingsChrome, mockRedirect } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockResolveSettingsChrome: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('./_lib/resolve-settings-chrome', () => ({
  resolveSettingsChrome: mockResolveSettingsChrome,
}));
vi.mock('./_components/settings-section-nav', () => ({
  SettingsSectionNav: ({ showTeamSection }: { showTeamSection: boolean }) => (
    <div data-testid="section-nav" data-show-team={String(showTeamSection)} />
  ),
}));

import SettingsLayout from './layout';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
});

describe('SettingsLayout', () => {
  it('redirects to /login when there is no user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(SettingsLayout({ children: <div /> })).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockResolveSettingsChrome).not.toHaveBeenCalled();
  });

  it('renders children without the tab bar when showSectionNav is false', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', companyId: 'c1' });
    mockResolveSettingsChrome.mockResolvedValue({
      showSectionNav: false,
      showTeamSection: false,
    });

    const ui = await SettingsLayout({ children: <div data-testid="child">Child content</div> });
    render(ui);

    expect(screen.queryByTestId('section-nav')).not.toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders the tab bar with the resolved showTeamSection when showSectionNav is true', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', companyId: 'c1' });
    mockResolveSettingsChrome.mockResolvedValue({
      showSectionNav: true,
      showTeamSection: true,
    });

    const ui = await SettingsLayout({ children: <div data-testid="child">Child content</div> });
    render(ui);

    const nav = screen.getByTestId('section-nav');
    expect(nav).toHaveAttribute('data-show-team', 'true');
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

// D-A — the executable form of the redirect decision. Folded here rather than a separate file.
describe('SettingsPage (redirect)', () => {
  it('redirects to /settings/billing unconditionally, with no session read', async () => {
    vi.resetModules();
    const { default: SettingsPage } = await import('./page');
    expect(() => SettingsPage()).toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/settings/billing');
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });
});
