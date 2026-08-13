import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseEarningsView, CasePartyView } from '@/lib/cases/case-view-types';
import { CasePartyCard } from './case-party-card';

/**
 * BAL-421 — the rail's counterparty card: ONE component for both lenses.
 *
 * ⚠⚠ ONLY A LIVE DESTINATION RENDERS, NEVER A DISABLED CTA. `expert_profiles.username` is
 * NULLABLE, so a null `bookAgainHref` must produce NO button rather than a link to
 * `/experts/null`. That is the branch this file exists to hold.
 *
 * ⚠ NO EMAIL ADDRESS ANYWHERE (ADR-1044) and NO RATING (owner decision D5 / BAL-422) — the
 * recap precedent is to OMIT rather than fake, so both absences are asserted over the whole
 * rendered tree.
 */

const PARTY: CasePartyView = {
  name: 'Amara Okafor',
  headline: 'Salesforce architect',
  orgLabel: 'CloudPeak',
  avatarUrl: null,
  initials: 'AO',
  bookAgainHref: '/experts/amara-okafor',
};

const NOT_YET: CaseEarningsView = {
  state: 'not_yet',
  earningsAudMinor: null,
  finalizedCount: 0,
  pendingCount: 0,
};

function renderCard(over: Readonly<Partial<React.ComponentProps<typeof CasePartyCard>>> = {}) {
  return render(
    <CasePartyCard party={PARTY} lens="client" isOpen counterpartyFirstName="Amara" {...over} />
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

  it('renders no rating — no stars, no score, no review count (D5 / BAL-422)', () => {
    const { container } = renderCard();
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['rating', 'review', '★']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('CasePartyCard — the booking CTA is a live destination or nothing', () => {
  it('links to the expert profile and names the counterparty', () => {
    renderCard();
    expect(screen.getByRole('link', { name: BOOK_AGAIN })).toHaveAttribute(
      'href',
      '/experts/amara-okafor'
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
