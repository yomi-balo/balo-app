import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { act, render, screen } from '@/test/utils';

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
import { resolveNavItems } from '@/components/layout/nav-registry';
import { resolveRouteDir } from '@/invariants/_source-scan';
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

/**
 * ⚠⚠ RESOLVED FROM THE REGISTRY, NEVER TYPED AS A LITERAL. This suite previously asserted the
 * CTA's href against the string `'/settings/expert'` — a route that does not exist — so CI
 * locked the bug in rather than catching it. Deriving the expectation from the same source the
 * page derives the prop from means the only way to get this wrong now is to break the registry
 * itself, which the "the route exists on disk" case below catches.
 */
const EXPERT_SETTINGS_HREF =
  resolveNavItems({ workspaceType: 'expert', capabilities: [] }, 'secondary').find(
    (entry) => entry.key === 'expert_settings'
  )?.href ?? null;

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
    nextBookingRoomReady: true,
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
    render(<CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Cases' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('uses the TITLE it is given, so a nav rename moves the crumb and the heading together', () => {
    render(
      <CasesIndexShell
        data={ready()}
        title="Consultations"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Consultations' })).toBeInTheDocument();
  });

  it('names the company on the client side and nobody on the expert side', () => {
    const { unmount } = render(
      <CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />
    );
    expect(screen.getByText('Everything Acme Corp has booked with experts.')).toBeInTheDocument();
    unmount();

    render(
      <CasesIndexShell
        data={ready({ side: 'expert' })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(screen.getByText('Everything clients have booked with you.')).toBeInTheDocument();
    expect(screen.queryByText(/Acme Corp/)).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE BOOK CTA LIVES IN THE PAGE, NOT THE TOP BAR (decisions D4) — the second deliberate
   * deviation. `TopNav` has no page-action slot and adding one is BAL-499/BAL-534's territory.
   */
  it('offers the Book CTA on the client side only, from the page body', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />
    );
    const cta = screen.getByRole('link', { name: /Book a consultation/ });
    expect(cta).toHaveAttribute('href', '/experts');
    await user.click(cta);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'book',
      card_state: null,
    });
    unmount();

    render(
      <CasesIndexShell
        data={ready({ side: 'expert' })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
      <CasesIndexShell
        data={{ kind: 'no_access', companyName: 'Acme Corp' }}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
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
    render(
      <CasesIndexShell
        data={{ kind: 'error' }}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
    render(
      <CasesIndexShell
        data={ready({ empty: 'no_cases', openCount: 0 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
        expertSetupHref={EXPERT_SETTINGS_HREF}
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
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(screen.getByText('Finish setup to get booked')).toBeInTheDocument();
    // ⚠ THE REGISTRY'S HREF, NOT A LITERAL. This assertion used to read `'/settings/expert'` — a
    // route that does not exist — so it locked the dead link in instead of catching it.
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      EXPERT_SETTINGS_HREF
    );
  });

  /**
   * ⚠⚠ THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Asserting the CTA matches whatever the
   * registry says is necessary but not sufficient — both could be wrong together. This checks the
   * destination is a REAL ROUTE on disk, which is the property "Continue setup is not a dead
   * link" actually depends on.
   */
  it('the expert-setup destination is a route that EXISTS', () => {
    expect(EXPERT_SETTINGS_HREF).not.toBeNull();
    const routeDir = resolveRouteDir([
      `src/app/(dashboard)${EXPERT_SETTINGS_HREF}/page.tsx`,
      `apps/web/src/app/(dashboard)${EXPERT_SETTINGS_HREF}/page.tsx`,
    ]);
    expect(routeDir, `${EXPERT_SETTINGS_HREF} has no page.tsx — the CTA is a dead link`).not.toBe(
      ''
    );
  });

  it('renders the setup state with NO button at all when the registry gives no href', () => {
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
        expertSetupHref={null}
      />
    );
    expect(screen.getByText('Finish setup to get booked')).toBeInTheDocument();
    // An absent action beats a dead one — never a guessed fallback destination.
    expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────────────────────

describe('CasesIndexShell — analytics', () => {
  it('fires cases_index_viewed EXACTLY ONCE, with the scope totals', () => {
    const { rerender } = render(
      <CasesIndexShell
        data={ready({ openCount: 26, resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    rerender(
      <CasesIndexShell
        data={ready({ openCount: 26, resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

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
    render(
      <CasesIndexShell
        data={ready({ featured: null })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
    render(
      <CasesIndexShell
        data={ready({ featured, open: [] })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    await user.click(screen.getByRole('link', { name: /Open case/ }));

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'case',
      card_state: 'live',
    });
  });

  /** BAL-581 — a featured card whose call room is not ready never reports `live`, even inside
   *  the join window: `resolveFeaturedTiming` keeps the server's own state. */
  it('reports the featured card as `booked`, never `live`, when its room is not ready inside the join window', async () => {
    const user = userEvent.setup();
    const featured = card({
      joinPath: '/meetings/m-1/call',
      nextBookingStartIso: new Date(Date.now() + 5 * MIN).toISOString(),
      nextBookingEndIso: new Date(Date.now() + 35 * MIN).toISOString(),
      nextBookingRoomReady: false,
    });
    render(
      <CasesIndexShell
        data={ready({ featured, open: [] })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    await user.click(screen.getByRole('link', { name: /Open case/ }));

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASES_INDEX_CLICKED, {
      target: 'case',
      card_state: 'booked',
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
        expertSetupHref={EXPERT_SETTINGS_HREF}
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
    render(<CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />);
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
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));

    // ⚠ NO PARTY ID ON THE WIRE — the action re-derives the scope from the session.
    expect(mockLoadMoreOpenCases).toHaveBeenCalledWith({ cursor: CURSOR });
    expect(await screen.findByText('Report builder timeouts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE REFRESH REGRESSION. `useRefreshOnFocus` calls `router.refresh()`, which re-renders this
   * component with fresh props WITHOUT remounting it — so `useState` initialisers do not re-run.
   * Before the fix, the rows appended by "Show more" survived that refresh and were rendered under
   * a fresh page one, against a cursor from the old ordering.
   */
  it('DISCARDS appended pages when a fresh read lands, and pages from the FRESH cursor', async () => {
    const user = userEvent.setup();
    mockLoadMoreOpenCases.mockResolvedValue({
      success: true,
      rows: [
        card({ engagementId: 'eng-3', href: '/cases/eng-3', title: 'Report builder timeouts' }),
      ],
      hasMore: true,
      nextCursor: { bucket: 1, sortRank: 9, id: 'eng-3' },
    });
    const { rerender } = render(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Report builder timeouts')).toBeInTheDocument();

    // A focus refresh: same component instance, brand-new `data` object.
    const FRESH_CURSOR = { bucket: 0, sortRank: 42, id: 'eng-7' };
    rerender(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: FRESH_CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    // The appended page is gone — it belonged to an ordering that no longer holds.
    expect(screen.queryByText('Report builder timeouts')).not.toBeInTheDocument();

    mockLoadMoreOpenCases.mockClear();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    // …and the next page is requested from the FRESH cursor, not the stale one.
    expect(mockLoadMoreOpenCases).toHaveBeenCalledWith({ cursor: FRESH_CURSOR });
  });

  it('never renders the same case twice after a refresh — no duplicate React keys', async () => {
    const user = userEvent.setup();
    // The appended row is the SAME case the fresh page one now carries in its grid: exactly the
    // shape that produced a duplicate key and a case rendering as both ticket and card.
    mockLoadMoreOpenCases.mockResolvedValue({
      success: true,
      rows: [
        card({
          engagementId: 'eng-2',
          href: '/cases/eng-2',
          title: 'Flow error on lead conversion',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const { rerender } = render(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    // Duplicated while the appended page is still held — the state this test exists to clear.
    expect(screen.getAllByText('Flow error on lead conversion')).toHaveLength(2);

    rerender(
      <CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />
    );
    expect(screen.getAllByText('Flow error on lead conversion')).toHaveLength(1);
  });

  it('a refresh does NOT re-fire cases_index_viewed — the reset is not a remount', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    rerender(
      <CasesIndexShell data={ready()} title="Cases" expertSetupHref={EXPERT_SETTINGS_HREF} />
    );

    const viewed = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === RECAP_EVENTS.CASES_INDEX_VIEWED);
    expect(viewed).toHaveLength(1);
  });

  /**
   * ⚠⚠ THE IN-FLIGHT RACE, which the reset alone does NOT close. The likely trigger is clicking
   * "Show more" in an UNFOCUSED window: the focus refresh and the click fire together, so a
   * request issued against the OLD payload resolves after the new one has landed. Without the
   * token check its rows are appended to a page one they were never paged against — exactly the
   * duplicate-row state the reset exists to prevent.
   */
  it('DISCARDS a "Show more" whose answer lands AFTER a fresh read', async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => {};
    mockLoadMoreOpenCases.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const { rerender } = render(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Show more' }));

    // The refresh lands FIRST — same component instance, new payload.
    rerender(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: { bucket: 0, sortRank: 99, id: 'eng-9' } })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    // …and only THEN does the in-flight request answer, with a page from the old ordering.
    await act(async () => {
      release({
        success: true,
        rows: [
          card({ engagementId: 'eng-3', href: '/cases/eng-3', title: 'Report builder timeouts' }),
        ],
        hasMore: false,
        nextCursor: null,
      });
    });

    expect(screen.queryByText('Report builder timeouts')).not.toBeInTheDocument();
    // …and its cursor did not overwrite the fresh one either.
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('toasts on failure rather than silently appending nothing', async () => {
    const user = userEvent.setup();
    mockLoadMoreOpenCases.mockResolvedValue({ success: false, error: 'nope' });
    render(
      <CasesIndexShell
        data={ready({ openHasMore: true, openCursor: CURSOR })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
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
    render(
      <CasesIndexShell
        data={ready({ resolvedCount: 0 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(screen.queryByRole('button', { name: /Resolved/ })).not.toBeInTheDocument();
  });

  it('starts COLLAPSED and fetches nothing until it is opened', () => {
    render(
      <CasesIndexShell
        data={ready({ resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    const toggle = screen.getByRole('button', { name: /Resolved/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(mockLoadMoreResolvedCases).not.toHaveBeenCalled();
  });

  it('loads page one on the first expansion, and reports the toggle both ways', async () => {
    const user = userEvent.setup();
    render(
      <CasesIndexShell
        data={ready({ resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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

  /**
   * ⚠ THE RESOLVED SECTION'S MILDER VERSION OF THE SAME REFRESH BUG: the COUNT updated on a
   * refresh while the already-loaded rows did not, so the heading disagreed with its own list.
   * The disclosure deliberately stays OPEN — collapsing a section the viewer opened would be a
   * second surprise — and page one is re-fetched instead.
   */
  it('re-fetches its rows when a fresh read lands, without collapsing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CasesIndexShell
        data={ready({ resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    await screen.findByText('Einstein bot handoff');
    expect(mockLoadMoreResolvedCases).toHaveBeenCalledTimes(1);

    mockLoadMoreResolvedCases.mockResolvedValue({
      success: true,
      rows: [{ ...resolvedRow(), engagementId: 'eng-8', title: 'Guided selling flow' }],
      hasMore: false,
      nextCursor: null,
    });
    rerender(
      <CasesIndexShell
        data={ready({ resolvedCount: 5 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    expect(screen.getByRole('button', { name: /Resolved/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(await screen.findByText('Guided selling flow')).toBeInTheDocument();
    expect(screen.queryByText('Einstein bot handoff')).not.toBeInTheDocument();
    expect(mockLoadMoreResolvedCases).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠⚠ THE RESOLVED SECTION'S VERSION OF THE SAME RACE, WHICH WAS WORSE. Its in-flight guard was
   * a boolean, so after a refresh reset it was still `true` from the pre-refresh request and the
   * effect's page-one reload was BLOCKED — while the in-flight request went on to append rows
   * 21-40 with no page one beneath them. Keyed on the token, the reload is never blocked by the
   * old payload's request, and the old payload's answer is dropped.
   */
  it('reloads page one after a refresh even with a request still in flight', async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => {};
    mockLoadMoreResolvedCases.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const { rerender } = render(
      <CasesIndexShell
        data={ready({ resolvedCount: 40 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    expect(mockLoadMoreResolvedCases).toHaveBeenCalledTimes(1);

    // The refresh lands while page one is still in flight.
    mockLoadMoreResolvedCases.mockResolvedValue({
      success: true,
      rows: [{ ...resolvedRow(), engagementId: 'eng-8', title: 'Guided selling flow' }],
      hasMore: false,
      nextCursor: null,
    });
    rerender(
      <CasesIndexShell
        data={ready({ resolvedCount: 41 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );

    // ⚠ NOT BLOCKED — the reload fires for the new payload.
    expect(await screen.findByText('Guided selling flow')).toBeInTheDocument();
    expect(mockLoadMoreResolvedCases).toHaveBeenCalledTimes(2);

    // …and the stale answer, arriving last, is discarded rather than stacked on top.
    await act(async () => {
      release({
        success: true,
        rows: [{ ...resolvedRow(), engagementId: 'eng-stale', title: 'Stale page' }],
        hasMore: false,
        nextCursor: null,
      });
    });
    expect(screen.queryByText('Stale page')).not.toBeInTheDocument();
    expect(screen.getByText('Guided selling flow')).toBeInTheDocument();
  });

  it('does NOT re-fetch when it is collapsed and opened again', async () => {
    const user = userEvent.setup();
    render(
      <CasesIndexShell
        data={ready({ resolvedCount: 4 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
      <CasesIndexShell
        data={ready({ resolvedCount: 1 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
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
    render(
      <CasesIndexShell
        data={ready({ side: 'expert', resolvedCount: 1 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    await user.click(screen.getByRole('button', { name: /Resolved/ }));
    await screen.findByText('Einstein bot handoff');
    expect(screen.queryByRole('link', { name: 'Book again' })).not.toBeInTheDocument();
  });

  it('toasts when the resolved page fails to load', async () => {
    const user = userEvent.setup();
    mockLoadMoreResolvedCases.mockResolvedValue({ success: false, error: 'nope' });
    render(
      <CasesIndexShell
        data={ready({ resolvedCount: 2 })}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
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
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the lock state', async () => {
    const { container } = render(
      <CasesIndexShell
        data={{ kind: 'no_access', companyName: 'Acme Corp' }}
        title="Cases"
        expertSetupHref={EXPERT_SETTINGS_HREF}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
