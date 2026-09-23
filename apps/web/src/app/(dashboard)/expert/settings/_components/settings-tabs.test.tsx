import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  within,
  type BoundFunctions,
  type queries,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileSettingsData } from '@balo/db';

// Router (SettingsTabs replaces the URL on tab change).
const { mockReplace } = vi.hoisted(() => ({ mockReplace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));

// Stub the heavy child tabs with identifiable testids.
vi.mock('./rate-tab', () => ({ RateTab: () => <div data-testid="rate-tab" /> }));
vi.mock('./payouts-tab', () => ({ PayoutsTab: () => <div data-testid="payouts-tab" /> }));
vi.mock('./profile-tab', () => ({ ProfileTab: () => <div data-testid="profile-tab" /> }));
vi.mock('./expertise-tab', () => ({ ExpertiseTab: () => <div data-testid="expertise-tab" /> }));
vi.mock('./work-history-tab', () => ({
  WorkHistoryTab: () => <div data-testid="work-history-tab" />,
}));
vi.mock('./certifications-tab', () => ({
  CertificationsTab: () => <div data-testid="certifications-tab" />,
}));
vi.mock('./schedule-tab', () => ({ ScheduleTab: () => <div data-testid="schedule-tab" /> }));
vi.mock('./agency-domains-tab', () => ({
  AgencyDomainsTab: () => <div data-testid="agency-domains-tab" />,
}));

import { SettingsTabs, type AgencyDomainsTabData } from './settings-tabs';

const PROFILE = {
  competencies: [],
  workHistory: [],
  certifications: [],
  skillsLocked: false,
  trailheadUrl: null,
} as unknown as ProfileSettingsData;

const REFERENCE = { languages: [], industries: [] };
const AGENCY: AgencyDomainsTabData = { agencyId: 'a1', partyName: 'Lattice', domains: [] };

interface RenderOptions {
  defaultTab?: string;
  setupStep?: string | null;
  canManageAgency?: boolean;
  agencyDomains?: AgencyDomainsTabData | null;
  profileData?: ProfileSettingsData | null;
  referenceData?: { languages: never[]; industries: never[] } | null;
  certCategories?: never[] | null;
}

function tabsElement(over: RenderOptions = {}): React.JSX.Element {
  return (
    <SettingsTabs
      defaultTab={over.defaultTab ?? 'rate'}
      setupStep={over.setupStep ?? null}
      initialRateCents={null}
      initialPayoutDetails={null}
      profileData={over.profileData ?? null}
      referenceData={over.referenceData ?? null}
      certCategories={over.certCategories ?? null}
      initialPhone={null}
      phoneVerifiedAt={null}
      canManageAgency={over.canManageAgency ?? false}
      agencyDomains={over.agencyDomains ?? null}
    />
  );
}

function renderTabs(over: RenderOptions = {}): ReturnType<typeof render> {
  return render(tabsElement(over));
}

type TablistQueries = BoundFunctions<typeof queries>;

const mainTablist = (): TablistQueries =>
  within(screen.getByRole('tablist', { name: 'Settings sections' }));
const subTablist = (): TablistQueries =>
  within(screen.getByRole('tablist', { name: 'Profile sections' }));

const classesOf = (el: HTMLElement): string[] => el.className.split(' ');
/** An SVG's `className` is an `SVGAnimatedString`, so read the attribute. */
const iconClassesOf = (tab: HTMLElement): string[] =>
  (tab.querySelector('svg')?.getAttribute('class') ?? '').split(' ');

beforeEach(() => {
  mockReplace.mockClear();
});

describe('SettingsTabs — content routing', () => {
  it('renders the ProfileTab when profile data is present', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    expect(screen.getByTestId('profile-tab')).toBeInTheDocument();
  });

  it('renders a data-load error when profile data is missing', () => {
    renderTabs({ defaultTab: 'profile', profileData: null });
    expect(screen.getByText(/failed to load profile data/i)).toBeInTheDocument();
  });

  it('renders the expertise / work-history / certifications sub-tabs with data', () => {
    renderTabs({ defaultTab: 'expertise', profileData: PROFILE, referenceData: REFERENCE });
    expect(screen.getByTestId('expertise-tab')).toBeInTheDocument();
    renderTabs({ defaultTab: 'workHistory', profileData: PROFILE });
    expect(screen.getByTestId('work-history-tab')).toBeInTheDocument();
  });

  it('renders a data-load error for a sub-tab without profile data', () => {
    renderTabs({ defaultTab: 'workHistory', profileData: null });
    expect(screen.getByText(/failed to load profile data/i)).toBeInTheDocument();
  });

  it('renders the certifications tab when categories are present', () => {
    renderTabs({ defaultTab: 'certifications', profileData: PROFILE, certCategories: [] });
    expect(screen.getByTestId('certifications-tab')).toBeInTheDocument();
  });

  it('renders an empty panel for certifications without categories', () => {
    renderTabs({ defaultTab: 'certifications', profileData: PROFILE, certCategories: null });
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement();
  });

  it('renders the rate / payouts / schedule main tabs', () => {
    renderTabs({ defaultTab: 'rate' });
    expect(screen.getByTestId('rate-tab')).toBeInTheDocument();
    renderTabs({ defaultTab: 'payouts' });
    expect(screen.getByTestId('payouts-tab')).toBeInTheDocument();
    renderTabs({ defaultTab: 'schedule' });
    expect(screen.getByTestId('schedule-tab')).toBeInTheDocument();
  });

  it('renders an empty panel for an unknown tab', () => {
    renderTabs({ defaultTab: 'nope' });
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement();
  });
});

describe('SettingsTabs — panel widths', () => {
  function wrapperOf(testId: string): HTMLElement {
    const wrapper = screen.getByTestId(testId).parentElement;
    if (!wrapper) throw new Error(`${testId} has no wrapper`);
    return wrapper;
  }

  it.each([
    ['schedule', 'max-w-[860px]', 'schedule-tab'],
    ['rate', 'max-w-[620px]', 'rate-tab'],
    ['payouts', 'max-w-[620px]', 'payouts-tab'],
    ['expertise', 'max-w-[620px]', 'expertise-tab'],
    ['workHistory', 'max-w-[620px]', 'work-history-tab'],
  ])('caps the %s panel at %s, left-aligned with the tab strip', (tab, width, testId) => {
    renderTabs({ defaultTab: tab, profileData: PROFILE, referenceData: REFERENCE });
    const wrapper = wrapperOf(testId);
    expect(classesOf(wrapper)).toContain(width);
    expect(classesOf(wrapper)).not.toContain('mx-auto');
  });

  it('caps the certifications panel at the form width', () => {
    renderTabs({ defaultTab: 'certifications', profileData: PROFILE, certCategories: [] });
    expect(classesOf(wrapperOf('certifications-tab'))).toEqual(['max-w-[620px]']);
  });

  it('caps the Domains panel at the wide width', () => {
    renderTabs({ defaultTab: 'domains', canManageAgency: true, agencyDomains: AGENCY });
    expect(classesOf(wrapperOf('agency-domains-tab'))).toEqual(['max-w-[860px]']);
  });

  it('gives the Profile builder the full container — no width wrapper', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    expect(screen.getByTestId('profile-tab').parentElement).toBe(screen.getByRole('tabpanel'));
  });
});

describe('SettingsTabs — agency Domains tab (BAL-347)', () => {
  it('does NOT show a Domains tab when the expert cannot manage an agency', () => {
    renderTabs({ canManageAgency: false });
    expect(screen.queryByRole('tab', { name: /domains/i })).not.toBeInTheDocument();
  });

  it('shows the Domains tab and renders AgencyDomainsTab when selected', async () => {
    const user = userEvent.setup();
    renderTabs({ canManageAgency: true, agencyDomains: AGENCY });

    const domainsTab = screen.getByRole('tab', { name: /domains/i });
    expect(domainsTab).toBeInTheDocument();

    await user.click(domainsTab);
    expect(screen.getByTestId('agency-domains-tab')).toBeInTheDocument();
  });

  it('renders an empty panel on Domains when the agency payload is missing', () => {
    renderTabs({ defaultTab: 'domains', canManageAgency: true, agencyDomains: null });
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement();
  });
});

describe('SettingsTabs — URL sync', () => {
  it('replaces the URL with the chosen tab, keeping the setup step', () => {
    renderTabs({ defaultTab: 'rate', setupStep: 'payouts' });
    fireEvent.click(mainTablist().getByRole('tab', { name: 'Payouts' }));
    expect(mockReplace).toHaveBeenCalledWith('/expert/settings?tab=payouts&setup=payouts', {
      scroll: false,
    });
  });

  it('omits the setup param when there is no setup step', () => {
    renderTabs({ defaultTab: 'rate' });
    fireEvent.click(mainTablist().getByRole('tab', { name: 'Schedule' }));
    expect(mockReplace).toHaveBeenCalledWith('/expert/settings?tab=schedule', { scroll: false });
  });

  it('lands the Profile main tab on the profile sub-tab', () => {
    renderTabs({ defaultTab: 'rate', profileData: PROFILE, referenceData: REFERENCE });
    fireEvent.click(mainTablist().getByRole('tab', { name: 'Profile' }));
    expect(mockReplace).toHaveBeenCalledWith('/expert/settings?tab=profile', { scroll: false });
    expect(subTablist().getByRole('tab', { name: 'Profile' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('profile-tab')).toBeInTheDocument();
  });

  it('switches Profile sub-tabs through the same URL sync', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    fireEvent.click(subTablist().getByRole('tab', { name: 'Expertise' }));
    expect(mockReplace).toHaveBeenCalledWith('/expert/settings?tab=expertise', { scroll: false });
    expect(screen.getByTestId('expertise-tab')).toBeInTheDocument();
  });

  it('follows the URL when the page hands it a new default tab', () => {
    const { rerender } = renderTabs({ defaultTab: 'rate' });
    rerender(tabsElement({ defaultTab: 'schedule' }));
    expect(screen.getByTestId('schedule-tab')).toBeInTheDocument();
    expect(mainTablist().getByRole('tab', { name: 'Schedule' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

describe('SettingsTabs — pill main strip, underline sub strip', () => {
  it('lists the main tabs in order, each with a decorative icon', () => {
    renderTabs({ canManageAgency: true, agencyDomains: AGENCY });
    const tabs = mainTablist().getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Profile',
      'Rate',
      'Schedule',
      'Payouts',
      'Domains',
    ]);
    for (const tab of tabs) {
      const icon = tab.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('lists the profile sub-tabs as text only, in order, with no icons', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    const tabs = subTablist().getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Profile',
      'Expertise',
      'Work History',
      'Certifications',
    ]);
    for (const tab of tabs) expect(tab.querySelector('svg')).toBeNull();
  });

  it('draws the main row as a muted pill strip, not an underline strip', () => {
    renderTabs({ defaultTab: 'rate' });
    const strip = mainTablist();
    const classes = classesOf(screen.getByRole('tablist', { name: 'Settings sections' }));
    expect(classes).toEqual(expect.arrayContaining(['bg-muted', 'rounded-xl', 'inline-flex']));
    expect(classes).not.toContain('shadow-[inset_0_-1px_0_var(--border)]');
    for (const tab of strip.getAllByRole('tab')) {
      expect(classesOf(tab)).not.toContain('border-b-2');
    }
  });

  it('raises the active main tab as a card chip with a primary icon; the rest stay muted', () => {
    renderTabs({ defaultTab: 'schedule' });
    const active = mainTablist().getByRole('tab', { name: 'Schedule' });
    const inactive = mainTablist().getByRole('tab', { name: 'Rate' });

    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(classesOf(active)).toEqual(
      expect.arrayContaining(['bg-card', 'shadow-sm', 'text-foreground'])
    );
    expect(iconClassesOf(active)).toContain('text-primary');

    expect(inactive).toHaveAttribute('aria-selected', 'false');
    expect(classesOf(inactive)).toContain('text-muted-foreground');
    expect(classesOf(inactive)).not.toContain('bg-card');
    expect(iconClassesOf(inactive)).toContain('text-muted-foreground');
  });

  it('colours the active profile sub-tab primary, text and underline', () => {
    renderTabs({ defaultTab: 'workHistory', profileData: PROFILE });
    const active = subTablist().getByRole('tab', { name: 'Work History' });
    expect(classesOf(active)).toEqual(
      expect.arrayContaining(['border-b-2', 'border-primary', 'text-primary'])
    );
    expect(mainTablist().getByRole('tab', { name: 'Profile' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('draws the sub strip’s rule inside the scroll container so the underline sits on it', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    const strip = screen.getByRole('tablist', { name: 'Profile sections' });
    expect(classesOf(strip)).toEqual(
      expect.arrayContaining(['overflow-x-auto', 'shadow-[inset_0_-1px_0_var(--border)]'])
    );
    expect(classesOf(strip)).not.toContain('border-b');
  });

  it('scrolls both strips inside their own width rather than widening a phone-width page', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });

    const sub = screen.getByRole('tablist', { name: 'Profile sections' });
    expect(classesOf(sub)).toEqual(
      expect.arrayContaining(['overflow-x-auto', 'contain-inline-size', 'scrollbar-none'])
    );

    // The pill hugs its tabs, so containment on the pill itself would collapse it to zero
    // width: it lives on the block wrapper, and the pill scrolls at the wrapper's width.
    const pill = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(classesOf(pill)).toEqual(
      expect.arrayContaining(['overflow-x-auto', 'max-w-full', 'scrollbar-none'])
    );
    expect(classesOf(pill)).not.toContain('contain-inline-size');
    expect(classesOf(pill.parentElement as HTMLElement)).toContain('contain-inline-size');
  });

  it('spaces the strips per row: 28px under a lone main strip, 24px when sub-tabs follow', () => {
    const mainRow = (): HTMLElement =>
      screen.getByRole('tablist', { name: 'Settings sections' }).parentElement as HTMLElement;

    const { unmount } = renderTabs({ defaultTab: 'rate' });
    expect(classesOf(mainRow())).toContain('mb-7');
    unmount();

    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    expect(classesOf(mainRow())).toContain('mb-6');
    expect(classesOf(screen.getByRole('tablist', { name: 'Profile sections' }))).toContain('mb-6');
  });

  it('keeps the panel’s min-content from widening a phone-width page', () => {
    renderTabs({ defaultTab: 'schedule' });
    expect(classesOf(screen.getByRole('tabpanel'))).toContain('contain-inline-size');
  });

  it('shows the sub-tab strip only under the Profile main tab', () => {
    renderTabs({ defaultTab: 'payouts' });
    expect(screen.queryByRole('tablist', { name: 'Profile sections' })).not.toBeInTheDocument();
  });
});

describe('SettingsTabs — tab / panel wiring', () => {
  it('labels the panel by the active main tab, which controls it', () => {
    renderTabs({ defaultTab: 'rate' });
    const panel = screen.getByRole('tabpanel');
    const active = mainTablist().getByRole('tab', { name: 'Rate' });

    expect(active).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', active.id);
    expect(mainTablist().getByRole('tab', { name: 'Payouts' })).not.toHaveAttribute(
      'aria-controls'
    );
  });

  it('labels the panel by the active sub-tab under Profile', () => {
    renderTabs({ defaultTab: 'expertise', profileData: PROFILE });
    const panel = screen.getByRole('tabpanel');
    const activeSub = subTablist().getByRole('tab', { name: 'Expertise' });

    expect(panel).toHaveAttribute('aria-labelledby', activeSub.id);
    expect(activeSub).toHaveAttribute('aria-controls', panel.id);
    expect(screen.getByRole('tabpanel', { name: 'Expertise' })).toBe(panel);
  });

  it('gives every tab a unique id', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    const ids = screen.getAllByRole('tab').map((t) => t.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * BAL-511 / ADR-1053. The design reference's motion spec reads:
 *   `tabs  deliberately static — no underline slide, no panel fade, no press scale,
 *          uniform font-weight (animated tabs read as jitter here)`
 * `settings-tabs.tsx` predated the spec and was the pattern the calendar switcher wrongly copied
 * — the spec, not this file, is the precedent. Flattened here: no `layoutId`, no
 * `AnimatePresence`, one font weight per tab row.
 */
describe('SettingsTabs — deliberately static (ADR-1053, BAL-511)', () => {
  it('renders exactly one tabpanel', () => {
    renderTabs({ defaultTab: 'rate' });
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('puts the new panel in the DOM synchronously — no await, no findBy, no exit hold', () => {
    renderTabs({ canManageAgency: true, agencyDomains: AGENCY });
    // `fireEvent` (not `userEvent`) on purpose: it is fully synchronous, so a single expression
    // after it proves the panel swapped in the same commit. Under `AnimatePresence mode="wait"`
    // the outgoing panel is held for an extra commit and this fails.
    fireEvent.click(screen.getByRole('tab', { name: /domains/i }));
    expect(screen.getByTestId('agency-domains-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('rate-tab')).not.toBeInTheDocument();
  });

  // ⚠ Two tablists, one tabpanel. `getAllByRole('tab')` returns both rows' tabs, so each weight
  // test is scoped to its own tablist by name (BAL-511 D11).
  const fontClassesOf = (el: HTMLElement): string[] =>
    el.className.split(' ').filter((token) => token.startsWith('font-'));

  it('the main tab row carries ONE font weight, present and identical on both arms', () => {
    renderTabs({ defaultTab: 'rate' });
    const active = mainTablist().getByRole('tab', { name: /rate/i });
    const inactive = mainTablist().getByRole('tab', { name: /payouts/i });
    expect(fontClassesOf(active)).toEqual(['font-medium']);
    expect(fontClassesOf(inactive)).toEqual(fontClassesOf(active));
  });

  it('the profile sub-tab row carries ONE font weight, present and identical on both arms', () => {
    renderTabs({ defaultTab: 'profile', profileData: PROFILE, referenceData: REFERENCE });
    const active = subTablist().getByRole('tab', { name: /^profile$/i });
    const inactive = subTablist().getByRole('tab', { name: /expertise/i });
    expect(fontClassesOf(active)).toEqual(['font-medium']);
    expect(fontClassesOf(inactive)).toEqual(fontClassesOf(active));
  });
});
