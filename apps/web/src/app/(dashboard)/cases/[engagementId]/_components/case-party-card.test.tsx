import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseEarningsView, CasePartyView } from '@/lib/cases/case-view-types';
import { CasePartyCard } from './case-party-card';

// BAL-400 — CasePartyCard now mounts `CaseSlotQuickPick` (which calls the real availability
// fetch) whenever `lens==='client' && isOpen`. That component has its own test file; here it's
// stubbed so this file stays scoped to the identity block + booking CTA it already covers.
const { mockQuickPickProps } = vi.hoisted(() => ({ mockQuickPickProps: vi.fn() }));
vi.mock('./case-slot-quick-pick', () => ({
  CaseSlotQuickPick: (props: Readonly<{ viewerEmailDomain: string | null }>) => {
    mockQuickPickProps(props);
    return <div data-testid="quick-pick-stub" />;
  },
}));

/**
 * BAL-421 — the rail's counterparty card: ONE component for both lenses.
 *
 * ⚠⚠ ONLY A LIVE DESTINATION RENDERS, NEVER A DISABLED CTA. `expert_profiles.username` is
 * NULLABLE, so a null `bookAgainHref` must produce NO button rather than a link to
 * `/experts/null`. That is the branch this file exists to hold.
 *
 * ⚠ NO EMAIL ADDRESS ANYWHERE (ADR-1044) — asserted over the whole rendered tree.
 *
 * ⚠ BAL-422 LANDED THE RATING LINE, so the old "no rating anywhere" assertion is GONE and is
 * replaced by the three branches that actually matter: it renders WITH ITS COUNT when the
 * aggregate exists, it renders NOTHING (never `0.0`) when `ratingAverage` is null, and the
 * EXPERT lens never carries one — the expert does not score the client.
 */

const PARTY: CasePartyView = {
  name: 'Amara Okafor',
  headline: 'Salesforce architect',
  orgLabel: 'CloudPeak',
  avatarUrl: null,
  initials: 'AO',
  bookAgainHref: '/experts/amara-okafor',
  ratingAverage: 4.3,
  ratingCount: 2,
};

const NOT_YET: CaseEarningsView = {
  state: 'not_yet',
  earningsAudMinor: null,
  finalizedCount: 0,
  pendingCount: 0,
};

function renderCard(over: Readonly<Partial<React.ComponentProps<typeof CasePartyCard>>> = {}) {
  return render(
    <CasePartyCard
      party={PARTY}
      lens="client"
      isOpen
      counterpartyFirstName="Amara"
      engagementId="engagement-1"
      expertProfileId="expert-1"
      caseTitle="Flow interview loop"
      consultationCount={2}
      openedAtIso="2026-06-12T09:00:00Z"
      viewerEmailDomain={null}
      {...over}
    />
  );
}

const BOOK_AGAIN = 'Book with Amara again';
const NEW_CASE_NOTE = 'Starts a new case — this one stays as it is.';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CasePartyCard — the identity block', () => {
  it('renders the name, headline, org label and initials', () => {
    renderCard();
    expect(screen.getByText('Amara Okafor')).toBeInTheDocument();
    expect(screen.getByText('Salesforce architect')).toBeInTheDocument();
    expect(screen.getByText('CloudPeak')).toBeInTheDocument();
    expect(screen.getByText('AO')).toBeInTheDocument();
  });

  it('omits the optional lines entirely when they are null', () => {
    renderCard({ party: { ...PARTY, headline: null, orgLabel: null } });
    expect(screen.getByText('Amara Okafor')).toBeInTheDocument();
    expect(screen.queryByText('Salesforce architect')).not.toBeInTheDocument();
    expect(screen.queryByText('CloudPeak')).not.toBeInTheDocument();
  });

  it('renders no email address and no mailto anywhere (ADR-1044)', () => {
    const { container } = renderCard();
    expect(container.innerHTML).not.toContain('mailto:');
    expect(container.textContent ?? '').not.toContain('@');
  });

  /**
   * ⚠ THE AVERAGE NEVER SHIPS WITHOUT ITS DENOMINATOR (BAL-422 AC). "4.3" alone reads as
   * settled evidence when it rests on two engagements; "4.3 (2)" does not.
   */
  it('renders the rating to one decimal WITH its engagement count', () => {
    const { container } = renderCard();
    expect(container.textContent ?? '').toContain('4.3');
    expect(container.textContent ?? '').toContain('(2)');
  });

  /**
   * ⚠ …AND THE DENOMINATOR REACHES A SCREEN READER, AS "ENGAGEMENTS". Star, value and count
   * are three separate nodes that announced as "4.3 2" — two orphan numbers.
   */
  it('gives the rating an accessible name that says engagements', () => {
    renderCard();
    expect(screen.getByText('Rated 4.3 out of 5 across 2 engagements')).toBeInTheDocument();
  });

  /** A whole number must still read as "5.0", matching the shipped RatingBadge treatment. */
  it('always shows one decimal place', () => {
    const { container } = renderCard({ party: { ...PARTY, ratingAverage: 5, ratingCount: 1 } });
    expect(container.textContent ?? '').toContain('5.0');
    expect(container.textContent ?? '').toContain('(1)');
  });

  /**
   * ⚠⚠ NULL MEANS NO REVIEWS AND MUST RENDER NOTHING — NEVER `0.0`. The scale starts at 1, so
   * a zero would be a fabricated bad score for an expert who simply has not been reviewed.
   */
  it('renders NO rating line at all when ratingAverage is null', () => {
    const { container } = renderCard({
      party: { ...PARTY, ratingAverage: null, ratingCount: 0 },
    });
    const text = container.textContent ?? '';
    expect(text).not.toContain('0.0');
    expect(text).not.toContain('(0)');
  });

  /**
   * ⚠⚠ NOTHING EVALUATIVE ON THE EXPERT LENS. The server enforces this by hardcoding
   * `ratingAverage: null` on that branch (`load-case.ts`); this pins the render consequence.
   */
  it('renders no rating on the EXPERT lens, whose counterparty is the client company', () => {
    const { container } = renderCard({
      lens: 'expert',
      party: {
        ...PARTY,
        name: 'Northwind Industrial',
        ratingAverage: null,
        ratingCount: 0,
      },
    });
    expect(container.textContent ?? '').not.toContain('0.0');
  });
});

describe('CasePartyCard — the booking CTA is a live destination or nothing', () => {
  // BAL-400 (D4a entry point 4) — the query params open the booking wrapper directly.
  it('links to the expert profile with the booking deep-link and names the counterparty', () => {
    renderCard();
    expect(screen.getByRole('link', { name: BOOK_AGAIN })).toHaveAttribute(
      'href',
      '/experts/amara-okafor?book=1&src=book_again'
    );
  });

  /** ⚠ THE NULL-USERNAME BRANCH. An absent action beats a link to `/experts/null`. */
  it('renders NO link at all when bookAgainHref is null', () => {
    const { container } = renderCard({ party: { ...PARTY, bookAgainHref: null } });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('/experts/');
    expect(screen.queryByText(NEW_CASE_NOTE)).not.toBeInTheDocument();
  });

  it('tracks the click with the lens it was rendered under', async () => {
    renderCard({ lens: 'expert' });
    await userEvent.setup().click(screen.getByRole('link', { name: BOOK_AGAIN }));
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'book_another',
      lens: 'expert',
    });
  });

  it('reports the CLIENT lens when rendered for a client', async () => {
    renderCard({ lens: 'client' });
    await userEvent.setup().click(screen.getByRole('link', { name: BOOK_AGAIN }));
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'book_another',
      lens: 'client',
    });
  });

  it('tracks nothing until the CTA is actually pressed', () => {
    renderCard();
    expect(track).not.toHaveBeenCalled();
  });

  /**
   * ⚠ A CLOSED CASE SAYS WHAT BOOKING DOES. Booking from a resolved case starts a NEW case, and
   * the copy states it rather than letting the viewer assume this one reopens.
   */
  it('adds the new-case note only on a CLOSED case', () => {
    const { unmount } = renderCard({ isOpen: false });
    expect(screen.getByText(NEW_CASE_NOTE)).toBeInTheDocument();
    unmount();

    renderCard({ isOpen: true });
    expect(screen.queryByText(NEW_CASE_NOTE)).not.toBeInTheDocument();
  });
});

// BAL-400 (D4a entry point 3) — the quick-pick strip is client-lens + open-case only.
describe('CasePartyCard — CaseSlotQuickPick gating', () => {
  it('renders the quick-pick for an open case on the client lens', () => {
    renderCard({ lens: 'client', isOpen: true });
    expect(screen.getByTestId('quick-pick-stub')).toBeInTheDocument();
  });

  it('omits the quick-pick on a closed case', () => {
    renderCard({ lens: 'client', isOpen: false });
    expect(screen.queryByTestId('quick-pick-stub')).not.toBeInTheDocument();
  });

  it('omits the quick-pick on the expert lens', () => {
    renderCard({ lens: 'expert', isOpen: true });
    expect(screen.queryByTestId('quick-pick-stub')).not.toBeInTheDocument();
  });

  // UX-2 (BAL-400 round 2) — the SESSION-derived domain must reach the composer honestly;
  // a hardcoded null here is exactly the bug UX-2 found on this entry point.
  it('forwards the real viewerEmailDomain to CaseSlotQuickPick, not a hardcoded null', () => {
    renderCard({ lens: 'client', isOpen: true, viewerEmailDomain: 'northwind.com' });
    expect(mockQuickPickProps).toHaveBeenCalledWith(
      expect.objectContaining({ viewerEmailDomain: 'northwind.com' })
    );
  });

  it('forwards null when the viewer domain is unknown', () => {
    renderCard({ lens: 'client', isOpen: true, viewerEmailDomain: null });
    expect(mockQuickPickProps).toHaveBeenCalledWith(
      expect.objectContaining({ viewerEmailDomain: null })
    );
  });
});

/**
 * ⚠⚠ FEE CONCEALMENT IS STRUCTURAL. A client-lens `CaseSurfaceView` has NO `earnings` field, so
 * the caller CANNOT pass one — the block's absence on the client arm is enforced by the type,
 * and this pins the render-layer consequence of both cases.
 */
describe('CasePartyCard — the earnings block is passed, never derived', () => {
  it('renders no earnings block when none is supplied', () => {
    const { container } = renderCard();
    expect(screen.queryByText('Earned on this case')).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('A$');
  });

  it('renders the block when the expert arm supplies one', () => {
    renderCard({ lens: 'expert', earnings: NOT_YET });
    expect(screen.getByText('Earned on this case')).toBeInTheDocument();
  });

  it('renders a finalized figure through to the DOM', () => {
    const { container } = renderCard({
      lens: 'expert',
      earnings: {
        state: 'finalized',
        earningsAudMinor: 45_000,
        finalizedCount: 3,
        pendingCount: 0,
      },
    });
    expect(container.textContent ?? '').toContain('A$');
  });
});
