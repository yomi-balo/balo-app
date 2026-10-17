import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import type { HelpCategoryGroup } from '@/lib/help/types';
import { HelpIndexView } from './help-index-view';

const clientGroups: HelpCategoryGroup[] = [
  {
    id: 'calls',
    title: 'Consultations and calls',
    blurb: 'Booking time.',
    order: 2,
    guides: [
      { slug: 'booking', title: 'Booking a call', summary: 'Pick a time.', audience: ['client'] },
    ],
  },
];

const groups = { client: clientGroups, expert: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HelpIndexView', () => {
  it('tracks the index view once on mount', () => {
    const { rerender } = render(
      <HelpIndexView initialAudience="client" groups={groups} signedIn />
    );
    rerender(<HelpIndexView initialAudience="client" groups={groups} signedIn />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.INDEX_VIEWED, {
      audience: 'client',
      signed_in: true,
    });
  });

  it('lists categories, topic nav and rows that carry the side and index source', () => {
    render(<HelpIndexView initialAudience="client" groups={groups} signedIn={false} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Balo help' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Topics' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Consultations and calls' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Booking a call/ })).toHaveAttribute(
      'href',
      '/help/booking?for=clients&src=index'
    );
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'help-tab-client');
  });

  it('switches side without a refetch, rewriting the URL and tracking the switch', async () => {
    const replaceState = vi.spyOn(globalThis.history, 'replaceState');
    render(<HelpIndexView initialAudience="client" groups={groups} signedIn={false} />);

    await userEvent.click(screen.getByRole('tab', { name: /I work as an expert/ }));

    expect(replaceState).toHaveBeenCalledWith(null, '', '/help?for=experts');
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.AUDIENCE_SWITCHED, {
      from: 'client',
      to: 'expert',
    });
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'help-tab-expert');
  });

  it('shows one invitation panel, with no absence copy, on a side with no guides', () => {
    render(<HelpIndexView initialAudience="expert" groups={groups} signedIn={false} />);

    expect(screen.getByRole('heading', { name: 'Need a hand with Balo?' })).toBeInTheDocument();
    expect(screen.getByText(/from setting up your profile to getting paid/)).toBeInTheDocument();
    expect(screen.queryByText(/on their way/)).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Topics' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Email support' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Still stuck?' })).not.toBeInTheDocument();
  });

  it('uses the client copy on an empty client side', () => {
    render(
      <HelpIndexView
        initialAudience="client"
        groups={{ client: [], expert: [] }}
        signedIn={false}
      />
    );

    expect(screen.getByText(/from your first booking to getting paid/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Browse guides for/ })).not.toBeInTheDocument();
  });

  it('offers a switch to the other side when that side has guides', async () => {
    render(<HelpIndexView initialAudience="expert" groups={groups} signedIn={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'Browse guides for clients' }));

    expect(screen.getByRole('tab', { name: /I’m hiring experts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('link', { name: /Booking a call/ })).toBeInTheDocument();
  });

  it('does not track or rewrite the URL when the selected side is chosen again', async () => {
    const replaceState = vi.spyOn(globalThis.history, 'replaceState');
    render(<HelpIndexView initialAudience="client" groups={groups} signedIn={false} />);
    vi.mocked(track).mockClear();
    replaceState.mockClear();

    await userEvent.click(screen.getByRole('tab', { name: /I’m hiring experts/ }));

    expect(track).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
