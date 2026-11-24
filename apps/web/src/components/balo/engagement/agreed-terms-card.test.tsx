import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '@/test/utils';
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import type { AgreedTermsView } from '@/lib/engagement/engagement-view';
import { AgreedTermsCard } from './agreed-terms-card';

function agreedTerms(overrides: Partial<AgreedTermsView> = {}): AgreedTermsView {
  return {
    assumptions: ['Sandbox access is provided.', 'Two review rounds.'],
    exclusions: ['Data migration.'],
    additionalTerms: ['Work is paused if feedback takes over 5 days.'],
    summary: '2 assumptions · 1 exclusion · 1 additional term',
    pricingMethod: 'fixed',
    clientCompanyName: 'Northwind Industrial',
    expertName: 'Priya Sharma',
    acceptedLine: 'Accepted by Dana @ Northwind Industrial on 24 November 2026.',
    acceptedTermsVersion: null,
    changedSinceStart: false,
    ...overrides,
  };
}

function renderCard(view: AgreedTermsView = agreedTerms()): ReturnType<typeof render> {
  return render(<AgreedTermsCard view={view} engagementId="eng-1" lens="client" />);
}

const TRIGGER = { name: /Agreed in the proposal/ };

describe('AgreedTermsCard', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
  });

  it('starts collapsed, showing only the header and the summary', () => {
    renderCard();

    const trigger = screen.getByRole('button', TRIGGER);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2 assumptions · 1 exclusion · 1 additional term')).toBeInTheDocument();
    expect(screen.getByText('Sandbox access is provided.')).not.toBeVisible();
    const controlled = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    expect(controlled).not.toBeNull();
    expect(controlled).not.toBeVisible();
  });

  it('opens to the accepted line, the three lists and Balo’s terms, in order', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', TRIGGER));

    const trigger = screen.getByRole('button', TRIGGER);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')).toBeVisible();
    expect(
      screen.getByText('Accepted by Dana @ Northwind Industrial on 24 November 2026.')
    ).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Assumptions',
      'Not included',
      'Priya Sharma’s additional terms',
      'Balo’s terms',
    ]);
    expect(screen.getByText('Sandbox access is provided.')).toBeInTheDocument();
    expect(screen.getByText('Data migration.')).toBeInTheDocument();
    expect(screen.getByText('Balo Project T&Cs')).toBeInTheDocument();
  });

  it('collapses again on a second click', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(screen.getByRole('button', TRIGGER));

    expect(screen.getByRole('button', TRIGGER)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Sandbox access is provided.')).not.toBeVisible();
  });

  it('opens to the page link when no terms version was recorded', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', TRIGGER));
    expect(screen.getByRole('link', { name: /Read the Project T&Cs/ })).toHaveAttribute(
      'href',
      '/legal/project-terms'
    );
    expect(screen.queryByRole('link', { name: /Agreement dated/ })).not.toBeInTheDocument();
  });

  it('opens to the PDF of the recorded terms version', async () => {
    const user = userEvent.setup();
    renderCard(agreedTerms({ acceptedTermsVersion: '2025-07-23' }));
    await user.click(screen.getByRole('button', TRIGGER));
    expect(
      screen.getByRole('link', { name: /Agreement dated 23 July 2025 \(PDF\)/ })
    ).toHaveAttribute('href', '/legal/balo-projects-msa-2025-07-23.pdf');
    expect(screen.queryByRole('link', { name: /Read the Project T&Cs/ })).not.toBeInTheDocument();
  });

  it('tracks the first open once, not on later toggles', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(screen.getByRole('button', TRIGGER));
    await user.click(screen.getByRole('button', TRIGGER));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ENGAGEMENT_EVENTS.AGREED_TERMS_OPENED, {
      engagement_id: 'eng-1',
      lens: 'client',
    });
  });

  it('omits an empty list and its heading', async () => {
    const user = userEvent.setup();
    renderCard(agreedTerms({ assumptions: [], additionalTerms: [] }));

    await user.click(screen.getByRole('button', TRIGGER));

    expect(screen.queryByRole('heading', { name: 'Assumptions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /additional terms/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Not included' })).toBeInTheDocument();
  });

  it('omits the accepted line when the acceptance cannot be attributed', async () => {
    const user = userEvent.setup();
    renderCard(agreedTerms({ acceptedLine: null }));

    await user.click(screen.getByRole('button', TRIGGER));

    expect(screen.queryByText(/^Accepted by/)).not.toBeInTheDocument();
  });

  it('points at the change history only when changes have been approved since', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard(agreedTerms({ changedSinceStart: true }));
    await user.click(screen.getByRole('button', TRIGGER));
    expect(
      screen.getByText(
        'This is what was agreed at the start. Changes approved since then are under “Changes to this project”.'
      )
    ).toBeInTheDocument();
    unmount();

    renderCard(agreedTerms({ changedSinceStart: false }));
    await user.click(screen.getByRole('button', TRIGGER));
    expect(screen.queryByText(/This is what was agreed at the start/)).not.toBeInTheDocument();
  });

  it('renders markup in a clause as literal text', async () => {
    const user = userEvent.setup();
    renderCard(agreedTerms({ assumptions: ['<b>bold</b> scope'], exclusions: [] }));

    await user.click(screen.getByRole('button', TRIGGER));

    expect(screen.getByText('<b>bold</b> scope')).toBeInTheDocument();
  });

  it('frames the pricing rule for a time and materials project', async () => {
    const user = userEvent.setup();
    renderCard(agreedTerms({ pricingMethod: 'tm' }));

    await user.click(screen.getByRole('button', TRIGGER));

    expect(
      screen.getByText(
        "This is a time and materials project. Northwind Industrial is billed for the hours logged each billing period. If a milestone goes over its estimate, Northwind Industrial is told, and raising an estimate needs Northwind Industrial's approval."
      )
    ).toBeInTheDocument();
  });
});
