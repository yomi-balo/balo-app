import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockUseViewerClock = vi.fn();
vi.mock('@/hooks/use-viewer-clock', () => ({ useViewerClock: () => mockUseViewerClock() }));

const mockUseRefreshOnFocus = vi.fn();
vi.mock('@/hooks/use-refresh-on-focus', () => ({
  useRefreshOnFocus: () => mockUseRefreshOnFocus(),
}));

const mockLoadMoreOpenCases = vi.fn();
const mockLoadMoreResolvedCases = vi.fn();
vi.mock('../_actions/load-more-cases', () => ({
  loadMoreOpenCases: (...a: unknown[]) => mockLoadMoreOpenCases(...a),
  loadMoreResolvedCases: (...a: unknown[]) => mockLoadMoreResolvedCases(...a),
}));

const mockToastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }));

import { CasesIndexShell } from './cases-index-shell';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type {
  CasesIndexCardView,
  CasesIndexData,
  CasesIndexResolvedRowView,
} from '../_lib/cases-index-view-types';

/**
 * BAL-567 — the index shell: the four non-list states, the Resolved disclosure, "show more", and
 * every analytics event this surface emits.
 */

const NOW = new Date('2026-09-16T04:30:00.000Z');
const MIN = 60_000;

function card(overrides: Partial<CasesIndexCardView> = {}): CasesIndexCardView {
  return {
    engagementId: 'eng-1',
    href: '/cases/eng-1',
    title: 'CPQ discount schedule errors',
    cardState: 'booked',
    counterpartyName: 'Marcus Lee',
    counterpartyOrgLabel: 'Stratus Advisory',
    counterpartyAvatarUrl: null,
    counterpartyInitials: 'ML',
    productTags: [],
    trail: [],
    heldCount: 0,
    actionItemsForYou: 0,
    unread: false,
    openedAtIso: '2026-09-02T00:00:00.000Z',
    nextBookingStartIso: new Date(NOW.getTime() + 180 * MIN).toISOString(),
    nextBookingEndIso: new Date(NOW.getTime() + 210 * MIN).toISOString(),
    nextBookingStatus: 'scheduled',
    lastCallAtIso: null,
    proposalOptionCount: null,
    actorLabel: null,
    bookAgainHref: '/experts/marcus',
    joinPath: null,
    ...overrides,
  };
}

function ready(
  overrides: Partial<Extract<CasesIndexData, { kind: 'ready' }>> = {}
): CasesIndexData {
  return {
    kind: 'ready',
    side: 'company',
    companyName: 'Acme Corp',
    featured: card({ joinPath: '/meetings/m-1/call' }),
    open: [
      card({ engagementId: 'eng-2', href: '/cases/eng-2', title: 'Flow error on lead conversion' }),
    ],
    openHasMore: false,
    openCursor: null,
    openCount: 2,
    resolvedCount: 0,
    empty: null,
    ...overrides,
  };
}

function resolvedRow(): CasesIndexResolvedRowView {
  return {
    engagementId: 'eng-9',
    href: '/cases/eng-9',
    title: 'Einstein bot handoff',
    counterpartyName: 'Marcus Lee',
    counterpartyOrgLabel: 'Stratus Advisory',
    closedAtIso: '2026-08-03T00:00:00.000Z',
    closeReason: 'auto_inactive',
    heldCount: 1,
    bookAgainHref: '/experts/marcus',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseViewerClock.mockReturnValue({ now: NOW, timeZone: 'UTC' });
  mockLoadMoreOpenCases.mockResolvedValue({
    success: true,
    rows: [],
    hasMore: false,
    nextCursor: null,
  });
  mockLoadMoreResolvedCases.mockResolvedValue({
    success: true,
    rows: [resolvedRow()],
    hasMore: false,
    nextCursor: null,
  });
});

// ── Heading and chrome ────────────────────────────────────────────────────────────────────────

describe('CasesIndexShell — the page heading', () => {
  /**
   * ⚠⚠ NO SECOND `<h1>` (decisions D3). BAL-499 shipped THE ONE `<h1>` in the top bar, so the
   * page's own heading is an `<h2>` — a DELIBERATE deviation from the design reference's
   * `PageHead`. A second `<h1>` is an a11y defect, not a style preference.
   */
  it('renders the title as an h2, never an h1', () => {
    render(<CasesIndexShell data={ready()} title="Cases" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Cases' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('uses the TITLE it is given, so a nav rename moves the crumb and the heading together', () => {
    render(<CasesIndexShell data={ready()} title="Consultations" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Consultations' })).toBeInTheDocument();
  });

  it('names the company on the client side and nobody on the expert side', () => {
    const { unmount } = render(<CasesIndexShell data={ready()} title="Cases" />);
    expect(screen.getByText('Everything Acme Corp has booked with experts.')).toBeInTheDocument();
    unmount();

    render(<CasesIndexShell data={ready({ side: 'expert' })} title="Cases" />);
    expect(screen.getByText('Everything clients have booked with you.')).toBeInTheDocument();
    expect(screen.queryByText(/Acme Corp/)).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE BOOK CTA LIVES IN THE PAGE, NOT THE TOP BAR (decisions D4) — the second deliberate
   * deviation. `TopNav` has no page-action slot and adding one is BAL-499/BAL-534's territory.
   */
  it('offers the Book CTA on the client side only, from the page body', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CasesIndexShell data={ready()} title="Cases" />);
    const cta = screen.getByRole('link', { name: /Book a consultation/ });
    expect(cta).toHaveAttribute('href', '/experts');
    await user.click(cta);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'book',
      card_state: null,
    });
    unmount();

    render(<CasesIndexShell data={ready({ side: 'expert' })} title="Cases" />);
    expect(screen.queryByRole('link', { name: /Book a consultation/ })).not.toBeInTheDocument();
  });
});

// ── The four non-list states ──────────────────────────────────────────────────────────────────

describe('CasesIndexShell — the non-list states', () => {
  /**
   * ⚠⚠ THE LOCK STATE IS RENDERED DIRECTLY, ON PURPOSE (decisions D9). It is UNREACHABLE by
   * construction as of this commit — all three shipped company roles grant `PARTICIPATE` — so an
   * end-to-end fixture would have to manufacture a state the system cannot produce, which proves
   * the fixture wrong rather than the branch right. This renders the branch the loader's
   * fail-closed arm returns, which is what the coverage is actually about.
   */
  it('renders the LOCK state, naming the company and pointing at Settings', () => {
    render(
      <CasesIndexShell data={{ kind: 'no_access', companyName: 'Acme Corp' }} title="Cases" />
    );
    expect(screen.getByText('You can’t view Acme Corp’s cases')).toBeInTheDocument();
    expect(
      screen.getByText(/An owner or admin can change your role in Settings/)
    ).toBeInTheDocument();
    // ⚠ AND NO LIST, AND NO BOOK CTA — a locked viewer is offered nothing.
    expect(screen.queryByRole('heading', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Book a consultation/ })).not.toBeInTheDocument();
  });

  it('renders the ERROR state with a retry that re-reads the page', async () => {
    const user = userEvent.setup();
    render(<CasesIndexShell data={{ kind: 'error' }} title="Cases" />);
    expect(screen.getByText('We couldn’t load your cases')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ THE EMPTY TITLES LEAD WITH THE ACTION — the house rule (CLAUDE.md / `balo-ui-skill`) over
   * the ticket's literal "No cases yet" (fix round X1). The absence-framed string is asserted
   * ABSENT on both sides so a well-meaning revert to the ticket's wording fails here rather than
   * shipping.
   */
  it('invites the CLIENT to book, and never frames the state as an absence', () => {
    render(<CasesIndexShell data={ready({ empty: 'no_cases', openCount: 0 })} title="Cases" />);
    expect(screen.getByText('Book your first consultation')).toBeInTheDocument();
    expect(screen.queryByText('No cases yet')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Find an expert' })).toHaveAttribute(
      'href',
      '/experts'
    );
  });

  it('offers the EXPERT no CTA on an empty list — there is nothing they can do from here', () => {
    render(
      <CasesIndexShell
        data={ready({ side: 'expert', empty: 'no_cases', openCount: 0, featured: null, open: [] })}
        title="Cases"
      />
    );
    // Forward-looking, not absence-framed — an empty expert workspace is a beginning, not a
    // record of nothing — but it still offers no action, because there genuinely is none.
    expect(screen.getByText('Ready for your first client')).toBeInTheDocument();
    expect(screen.queryByText('No cases yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Find an expert' })).not.toBeInTheDocument();
  });

  it('points an EXPERT with unfinished setup at setup instead', () => {
    render(
      <CasesIndexShell
        data={ready({
          side: 'expert',
          empty: 'expert_setup_incomplete',
          openCount: 0,
          featured: null,
          open: [],
        })}
        title="Cases"
      />
    );
    expect(screen.getByText('Finish setup to get booked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      '/settings/expert'
    );
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────────────────────

describe('CasesIndexShell — analytics', () => {
  it('fires cases_index_viewed EXACTLY ONCE, with the scope totals', () => {
    const { rerender } = render(
      <CasesIndexShell data={ready({ openCount: 26, resolvedCount: 4 })} title="Cases" />
    );
    rerender(<CasesIndexShell data={ready({ openCount: 26, resolvedCount: 4 })} title="Cases" />);

    const viewed = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === RECAP_EVENTS.CASES_INDEX_VIEWED);
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.[1]).toEqual({
      workspace_type: 'company',
      open_count: 26,
      resolved_count: 4,
      has_featured: true,
    });
  });

  it('reports has_featured: false when nothing is booked', () => {
    render(<CasesIndexShell data={ready({ featured: null })} title="Cases" />);
    expect(track).toHaveBeenCalledWith(
      RECAP_EVENTS.CASES_INDEX_VIEWED,
      expect.objectContaining({ has_featured: false })
    );
  });

  /**
   * ⚠⚠ `card_state` IS RESOLVED AT CLICK TIME. The featured card's server state is `booked`; if
   * the viewer clicks while the join window is open, the event must say `live`. Reporting the
   * server's stamp would make every "clicked while live" figure wrong.
   */
  it('reports the featured card as `live` when it is clicked inside the join window', async () => {
    const user = userEvent.setup();
    const featured = card({
      joinPath: '/meetings/m-1/call',
      nextBookingStartIso: new Date(Date.now() + 5 * MIN).toISOString(),
      nextBookingEndIso: new Date(Date.now() + 35 * MIN).toISOString(),
    });
    render(<CasesIndexShell data={ready({ featured, open: [] })} title="Cases" />);

    await user.click(screen.getByRole('link', { name: /Open case/ }));

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'case',
      card_state: 'live',
    });
  });

  it('reports a GRID card with its own server-derived state', async () => {
    const user = userEvent.setup();
    render(
      <CasesIndexShell
        data={ready({
          featured: null,
          open: [
            card({
              engagementId: 'eng-2',
              href: '/cases/eng-2',
              cardState: 'nothing_booked',
              nextBookingStartIso: null,
              nextBookingEndIso: null,
              nextBookingStatus: null,
            }),
          ],
        })}
        title="Cases"
      />
    );

    // ⚠ DESTRUCTURE + GUARD, never an index-position `!` — SonarCloud analyses WITHOUT
    // `noUncheckedIndexedAccess`, so it reads such an assertion as "unnecessary" and fails the
    // gate on a false positive. CLAUDE.md's house fix is to guard (memory
    // `reference_sonar_nonnull_false_positive`).
    const [titleLink] = screen.getAllByRole('link', { name: /CPQ discount schedule errors/ });
    if (titleLink === undefined) throw new Error('expected the card title to be a link');
    await user.click(titleLink);

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'case',
      card_state: 'nothing_booked',
    });
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────────────────────

describe('CasesIndexShell — "show more"', () => {
  const CURSOR = { bucket: 0, sortRank: 1, id: 'eng-2' };

  it('renders no button when there is nothing more', () => {
    render(<CasesIndexShell data={ready()} title="Cases" />);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('sends ONLY the cursor, and appends the page it gets back', async () => {
    const user = userEvent.setup();
    mockLoadMoreOpenCases.mockResolvedValue({
      success: true,
      rows: [
        card({ engagementId: 'eng-3', href: '/cases/eng-3', title: 'Report builder timeouts' }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    render(
      <CasesIndexShell data={ready({ openHasMore: true, openCursor: CURSOR })} title="Cases" />
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));

    // ⚠ NO PARTY ID ON THE WIRE — the action re-derives the scope from the session.
    expect(mockLoadMoreOpenCases).toHaveBeenCalledWith({ cursor: CURSOR });
    expect(await screen.findByText('Report builder timeouts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('toasts on failure rather than silently appending nothing', async () => {
    const user = userEvent.setup();
    mockLoadMoreOpenCases.mockResolvedValue({ success: false, error: 'nope' });
    render(
      <CasesIndexShell data={ready({ openHasMore: true, openCursor: CURSOR })} title="Cases" />
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));

    expect(mockToastError).toHaveBeenCalledWith(
      'We couldn’t load more cases. Try again in a moment.'
    );
  });
});

// ── The Resolved disclosure ───────────────────────────────────────────────────────────────────

describe('CasesIndexShell — the Resolved section', () => {
  it('is absent entirely when nothing is resolved', () => {
    render(<CasesIndexShell data={ready({ resolvedCount: 0 })} title="Cases" />);
    expect(screen.queryByRole('button', { name: /Resolved/ })).not.toBeInTheDocument();
  });

  it('starts COLLAPSED and fetches nothing until it is opened', () => {
    render(<CasesIndexShell data={ready({ resolvedCount: 4 })} title="Cases" />);
    const toggle = screen.getByRole('button', { name: /Resolved/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(mockLoadMoreResolvedCases).not.toHaveBeenCalled();
  });

  it('loads page one on the first expansion, and reports the toggle both ways', async () => {
    const user = userEvent.setup();
    render(<CasesIndexShell data={ready({ resolvedCount: 4 })} title="Cases" />);
    const toggle = screen.getByRole('button', { name: /Resolved/ });

    await user.click(toggle);
    expect(mockLoadMoreResolvedCases).toHaveBeenCalledWith({ cursor: null });
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_RESOLVED_TOGGLED, {
      expanded: true,
    });
    expect(await screen.findByText('Einstein bot handoff')).toBeInTheDocument();
    expect(screen.getByText('Closed automatically on')).toBeInTheDocument();
    expect(screen.getByText('1 held')).toBeInTheDocument();

    await user.click(toggle);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_RESOLVED_TOGGLED, {
      expanded: false,
    });
  });

  it('does NOT re-fetch when it is collapsed and opened again', async () => {
    const user = userEvent.setup();
    render(<CasesIndexShell data={ready({ resolvedCount: 4 })} title="Cases" />);
    const toggle = screen.getByRole('button', { name: /Resolved/ });

    await user.click(toggle);
    await screen.findByText('Einstein bot handoff');
    await user.click(toggle);
    await user.click(toggle);

    expect(mockLoadMoreResolvedCases).toHaveBeenCalledTimes(1);
  });

  it('offers "Book again" to the CLIENT side only', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <CasesIndexShell data={ready({ resolvedCount: 1 })} title="Cases" />
    );
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    const bookAgain = await screen.findByRole('link', { name: 'Book again' });
    expect(bookAgain).toHaveAttribute('href', '/experts/marcus');
    await user.click(bookAgain);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'book_again',
      card_state: null,
    });
    unmount();

    mockLoadMoreResolvedCases.mockResolvedValue({
      success: true,
      rows: [
        {
          ...resolvedRow(),
          counterpartyName: 'Acme Corp',
          counterpartyOrgLabel: null,
          bookAgainHref: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    render(<CasesIndexShell data={ready({ side: 'expert', resolvedCount: 1 })} title="Cases" />);
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    await screen.findByText('Einstein bot handoff');
    expect(screen.queryByRole('link', { name: 'Book again' })).not.toBeInTheDocument();
  });

  it('toasts when the resolved page fails to load', async () => {
    const user = userEvent.setup();
    mockLoadMoreResolvedCases.mockResolvedValue({ success: false, error: 'nope' });
    render(<CasesIndexShell data={ready({ resolvedCount: 2 })} title="Cases" />);
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    expect(mockToastError).toHaveBeenCalled();
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────────────────────

describe('CasesIndexShell — accessibility', () => {
  it('has no axe violations on a populated page', async () => {
    const { container } = render(
      <CasesIndexShell
        data={ready({
          resolvedCount: 3,
          openHasMore: true,
          openCursor: { bucket: 0, sortRank: 1, id: 'eng-2' },
        })}
        title="Cases"
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the lock state', async () => {
    const { container } = render(
      <CasesIndexShell data={{ kind: 'no_access', companyName: 'Acme Corp' }} title="Cases" />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
