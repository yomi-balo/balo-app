import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';

let pathname = '/settings/company';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { SettingsSectionNav } from './settings-section-nav';

beforeEach(() => {
  vi.clearAllMocks();
  pathname = '/settings/company';
});

describe('SettingsSectionNav', () => {
  it('renders 4 tabs when showTeamSection is true', () => {
    render(<SettingsSectionNav showTeamSection />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(nav).toBeInTheDocument();
  });

  it('renders 3 tabs when showTeamSection is false (Team omitted)', () => {
    render(<SettingsSectionNav showTeamSection={false} />);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: /Team/ })).not.toBeInTheDocument();
  });

  it('renders the expected hrefs and labels', () => {
    render(<SettingsSectionNav showTeamSection />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual([
      'Company',
      'Team',
      'Credits & billing',
      'Notifications',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/settings/company',
      '/settings/team',
      '/settings/billing',
      '/settings/notifications',
    ]);
  });

  it('marks exactly the active section with aria-current="page"', () => {
    pathname = '/settings/billing';
    render(<SettingsSectionNav showTeamSection />);
    const billing = screen.getByRole('link', { name: /Credits & billing/ });
    expect(billing).toHaveAttribute('aria-current', 'page');
    const company = screen.getByRole('link', { name: /Company/ });
    expect(company).not.toHaveAttribute('aria-current');
  });

  it('uses <nav aria-label> + links, never role="tab"', () => {
    const { container } = render(<SettingsSectionNav showTeamSection />);
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('fires settings_section_viewed once for the active section on mount', () => {
    pathname = '/settings/billing';
    render(<SettingsSectionNav showTeamSection />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(SETTINGS_EVENTS.SECTION_VIEWED, { section: 'billing' });
  });

  it('fires once per mount, and once more only when the active section actually changes', () => {
    // ⚠ HONEST SCOPE. This pins the effect's DEP-ARRAY behaviour, NOT the `lastFired` ref.
    //
    // The ref is deliberately NOT claimed to be pinned here, because it is not observable in this
    // environment: rendering through `<StrictMode>` and deleting the ref entirely still yields
    // exactly one `track` call (verified empirically). A plain `rerender()` proves even less — the
    // deps `[active, isVisible]` are unchanged primitives, so React skips the effect whether or
    // not the ref exists. The ref is retained as defence-in-depth (matching
    // `dashboard-wallet-card.tsx`'s precedent) for real-browser StrictMode, where the double
    // invoke does re-run effects — but no test in this suite should imply it is covered here.
    pathname = '/settings/billing';
    const { rerender } = render(
      <StrictMode>
        <SettingsSectionNav showTeamSection />
      </StrictMode>
    );
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(SETTINGS_EVENTS.SECTION_VIEWED, { section: 'billing' });

    // A genuine navigation to another section IS a new view and must emit again.
    pathname = '/settings/company';
    rerender(
      <StrictMode>
        <SettingsSectionNav showTeamSection />
      </StrictMode>
    );
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenLastCalledWith(SETTINGS_EVENTS.SECTION_VIEWED, { section: 'company' });
  });

  it('does NOT fire for /settings/team when showTeamSection is false (tab not visible)', () => {
    pathname = '/settings/team';
    render(<SettingsSectionNav showTeamSection={false} />);
    expect(track).not.toHaveBeenCalled();
  });

  it('does NOT fire on /settings/account (not a settings section)', () => {
    pathname = '/settings/account';
    render(<SettingsSectionNav showTeamSection />);
    expect(track).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SettingsSectionNav showTeamSection />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * BAL-511 / ADR-1053 (orchestrator scope addition, D18). This was a THIRD sliding-pill tab bar
 * carrying the same `layoutId="settings-section-pill"` spring as the other two flattened
 * controls. `aria-current="page"` and the link/routing behaviour are unchanged — only the motion
 * is removed.
 */
describe('SettingsSectionNav — deliberately static (ADR-1053, BAL-511)', () => {
  it('renders no sliding pill element at all', () => {
    pathname = '/settings/billing';
    const { container } = render(<SettingsSectionNav showTeamSection />);
    // ⚠ Narrowed to the PILL's own signature (`absolute` + `inset-0`) rather than bare
    // `absolute`, which would false-alarm on any future legitimate absolutely-positioned element
    // in this tree — a badge, a focus ring, a dropdown — and send someone hunting a pill that is
    // not there. The removed pill was `bg-card absolute inset-0 rounded-lg shadow-sm`.
    expect(container.querySelector('[class*="absolute"][class*="inset-0"]')).toBeNull();
  });

  it('carries ONE font weight, present and identical on the active and inactive links', () => {
    pathname = '/settings/billing';
    render(<SettingsSectionNav showTeamSection />);
    const fontClassesOf = (el: HTMLElement): string[] =>
      el.className.split(' ').filter((token) => token.startsWith('font-'));

    const active = screen.getByRole('link', { name: /Credits & billing/ });
    const inactive = screen.getByRole('link', { name: /Company/ });
    expect(fontClassesOf(active)).toEqual(['font-medium']);
    expect(fontClassesOf(inactive)).toEqual(fontClassesOf(active));
  });

  it('differentiates the active link by background and colour only', () => {
    pathname = '/settings/billing';
    render(<SettingsSectionNav showTeamSection />);
    const active = screen.getByRole('link', { name: /Credits & billing/ });
    const inactive = screen.getByRole('link', { name: /Company/ });
    expect(active.className).toContain('bg-card');
    expect(active.className).toContain('shadow-sm');
    expect(inactive.className).not.toContain('bg-card');
    expect(inactive.className).not.toContain('shadow-sm');
  });
});
