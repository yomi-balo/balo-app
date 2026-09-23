import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';
import { SetupBanner } from './setup-banner';

type ItemKey = keyof ChecklistStatus['items'];

/** Every item done except the ones named; counts derived from the items themselves. */
function statusWithOpen(...open: ItemKey[]): ChecklistStatus {
  const items: ChecklistStatus['items'] = {
    profile: true,
    phone: true,
    rate: true,
    calendar: true,
    availability: true,
    payouts: true,
  };
  for (const key of open) items[key] = false;
  const completedCount = Object.values(items).filter(Boolean).length;
  return {
    items,
    completedCount,
    allComplete: completedCount === CHECKLIST_ITEMS.length,
    rateCents: 10000,
    calendarNeedsReconnect: false,
  };
}

function bannerText(): string {
  return screen.getByText(/Not visible to clients yet/).textContent ?? '';
}

function continueLink(): HTMLElement | null {
  return screen.queryByRole('link', { name: /continue setup/i });
}

describe('SetupBanner — setup incomplete', () => {
  it('names the first incomplete step in checklist order, first letter lower-cased', () => {
    render(
      <SetupBanner
        status={statusWithOpen('payouts', 'calendar')}
        activeTab="rate"
        setupStep={null}
      />
    );

    // `calendar` precedes `payouts` in CHECKLIST_ITEMS, whatever order the fixture opened them.
    expect(screen.getByText('connect calendar').tagName).toBe('STRONG');
    expect(bannerText()).toBe(
      'Not visible to clients yet — next, connect calendar (1 more step after that)'
    );
  });

  it('pluralises the steps remaining after the next one', () => {
    render(
      <SetupBanner
        status={statusWithOpen('rate', 'availability', 'payouts')}
        activeTab="profile"
        setupStep={null}
      />
    );

    expect(bannerText()).toBe(
      'Not visible to clients yet — next, set your rate (2 more steps after that)'
    );
  });

  it('counts every open item against the real checklist, never a hard-coded total', () => {
    const allOpen = CHECKLIST_ITEMS.map((item) => item.key);
    render(<SetupBanner status={statusWithOpen(...allOpen)} activeTab="rate" setupStep={null} />);

    expect(bannerText()).toBe(
      `Not visible to clients yet — next, complete your profile (${CHECKLIST_ITEMS.length - 1} more steps after that)`
    );
  });

  it('drops the parenthetical when the next step is the last one open', () => {
    render(<SetupBanner status={statusWithOpen('payouts')} activeTab="rate" setupStep={null} />);

    expect(bannerText()).toBe('Not visible to clients yet — next, set up payouts');
    expect(screen.queryByText(/after that/)).not.toBeInTheDocument();
  });

  it('is invitation-framed, never absence-framed', () => {
    render(<SetupBanner status={statusWithOpen('phone')} activeTab="rate" setupStep={null} />);

    expect(screen.queryByText(/no .* yet/i)).not.toBeInTheDocument();
    expect(bannerText()).toContain('next, verify your phone');
  });
});

describe('SetupBanner — the Continue setup link', () => {
  it.each([
    ['profile', 'rate', '/expert/settings?tab=profile&setup=profile'],
    ['phone', 'rate', '/expert/settings?tab=profile&setup=phone'],
    ['rate', 'profile', '/expert/settings?tab=rate&setup=rate'],
    ['calendar', 'rate', '/expert/settings?tab=schedule&setup=calendar'],
    ['availability', 'rate', '/expert/settings?tab=schedule&setup=availability'],
    ['payouts', 'rate', '/expert/settings?tab=payouts&setup=payouts'],
  ] as const)('links the next step %s to its own tab (from %s)', (open, activeTab, href) => {
    render(<SetupBanner status={statusWithOpen(open)} activeTab={activeTab} setupStep={null} />);

    expect(continueLink()).toHaveAttribute('href', href);
  });

  it.each([
    ['profile', 'profile'],
    ['phone', 'profile'],
    ['rate', 'rate'],
    ['calendar', 'schedule'],
    ['availability', 'schedule'],
    ['payouts', 'payouts'],
  ] as const)('is hidden while the next step %s is already on its tab (%s)', (open, activeTab) => {
    render(<SetupBanner status={statusWithOpen(open)} activeTab={activeTab} setupStep={null} />);

    expect(bannerText()).toContain('Not visible to clients yet');
    expect(continueLink()).not.toBeInTheDocument();
  });

  it('shows on a profile sub-tab that is not the profile step’s own panel', () => {
    render(
      <SetupBanner status={statusWithOpen('profile')} activeTab="expertise" setupStep={null} />
    );

    expect(continueLink()).toHaveAttribute('href', '/expert/settings?tab=profile&setup=profile');
  });
});

describe('SetupBanner — arriving from the checklist (?setup=)', () => {
  function dashboardLink(): HTMLElement | null {
    return screen.queryByRole('link', { name: 'Dashboard' });
  }

  it('names the step the expert came to do, even with an earlier step still open', () => {
    render(
      <SetupBanner
        status={statusWithOpen('profile', 'calendar', 'payouts')}
        activeTab="schedule"
        setupStep="calendar"
      />
    );

    expect(screen.getByText('connect calendar').tagName).toBe('STRONG');
    expect(bannerText()).toBe(
      'Not visible to clients yet — step 4 of 6, connect calendar (2 more steps after this)'
    );
    expect(screen.queryByText('complete your profile')).not.toBeInTheDocument();
  });

  it('hides Continue setup while the chosen step is on its own tab', () => {
    render(
      <SetupBanner
        status={statusWithOpen('profile', 'calendar')}
        activeTab="schedule"
        setupStep="calendar"
      />
    );

    expect(continueLink()).not.toBeInTheDocument();
  });

  it('points Continue setup back at the chosen step from another tab', () => {
    render(
      <SetupBanner
        status={statusWithOpen('profile', 'calendar')}
        activeTab="rate"
        setupStep="calendar"
      />
    );

    expect(continueLink()).toHaveAttribute('href', '/expert/settings?tab=schedule&setup=calendar');
  });

  it('drops the parenthetical when the chosen step is the only one open', () => {
    render(
      <SetupBanner status={statusWithOpen('payouts')} activeTab="payouts" setupStep="payouts" />
    );

    expect(bannerText()).toBe('Not visible to clients yet — step 6 of 6, set up payouts');
  });

  it('falls back to the next open step once the chosen step is already done', () => {
    render(
      <SetupBanner status={statusWithOpen('payouts')} activeTab="schedule" setupStep="calendar" />
    );

    expect(bannerText()).toBe('Not visible to clients yet — next, set up payouts');
    expect(continueLink()).toHaveAttribute('href', '/expert/settings?tab=payouts&setup=payouts');
  });

  it('offers the way back to the dashboard only when the expert came from the checklist', () => {
    const { rerender } = render(
      <SetupBanner status={statusWithOpen('calendar')} activeTab="schedule" setupStep="calendar" />
    );
    expect(dashboardLink()).toHaveAttribute('href', '/dashboard');

    rerender(
      <SetupBanner status={statusWithOpen('calendar')} activeTab="schedule" setupStep={null} />
    );
    expect(dashboardLink()).not.toBeInTheDocument();
  });

  it('keeps the dashboard link beside Continue setup', () => {
    render(
      <SetupBanner
        status={statusWithOpen('rate', 'calendar')}
        activeTab="rate"
        setupStep="calendar"
      />
    );

    expect(dashboardLink()).toBeInTheDocument();
    expect(continueLink()).toBeInTheDocument();
  });
});

describe('SetupBanner — setup complete', () => {
  it('shows the quiet one-line confirmation and nothing else', () => {
    render(<SetupBanner status={statusWithOpen()} activeTab="profile" setupStep={null} />);

    expect(screen.getByText("You're appearing in search.")).toBeInTheDocument();
    expect(screen.queryByText(/Not visible to clients yet/)).not.toBeInTheDocument();
    expect(continueLink()).not.toBeInTheDocument();
  });

  it('renders nothing for an inconsistent snapshot that is not complete but has no open item', () => {
    const { container } = render(
      <SetupBanner
        status={{ ...statusWithOpen(), allComplete: false }}
        activeTab="profile"
        setupStep={null}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
