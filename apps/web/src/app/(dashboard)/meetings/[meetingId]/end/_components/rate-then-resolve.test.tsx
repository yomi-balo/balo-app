import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type {
  EndOfCallRatingView,
  EndOfCallResolveView,
} from '@/lib/meetings/end-of-call-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));
// ⚠ `'wait'` — both halves of this island swap their own content in place and move focus across
// the swap. See `@/test/motion-stub` for why the passthrough stub hides a broken handoff.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub({ animatePresenceMode: 'wait' });
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockSubmit = vi.fn();
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: (...a: unknown[]) => mockSubmit(...a),
}));

const mockResolveCase = vi.fn();
vi.mock('../../_actions/resolve-case', () => ({
  resolveCaseAction: (...a: unknown[]) => mockResolveCase(...a),
}));

import { RateThenResolve } from './rate-then-resolve';

const UNRATED: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'none' },
  existingBody: null,
};
const RATED_OK: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_ok', rating: 5 },
  existingBody: null,
};
const RATED_LOW: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_low', rating: 3 },
  existingBody: null,
};
const OPEN_CASE: EndOfCallResolveView = {
  engagementId: ENGAGEMENT_ID,
  requesterLabel: null,
  alreadyClosed: false,
  expertShortName: 'Amara',
};

function renderIsland(
  rating: EndOfCallRatingView | null,
  resolve: EndOfCallResolveView | null,
  noun = 'consultation'
) {
  return render(
    <RateThenResolve
      meetingId={MEETING_ID}
      rating={rating}
      resolve={resolve}
      counterpartyName="Amara"
      noun={noun}
    />
  );
}

const ASK = 'Is this issue resolved?';

describe('RateThenResolve — the ORDERING RULE: rate first, then resolve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('withholds the resolve prompt while no rating exists', () => {
    renderIsland(UNRATED, OPEN_CASE);
    expect(screen.getByText('How was your consultation with Amara?')).toBeInTheDocument();
    // ⚠ ABSENT, not disabled.
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sorted/i })).not.toBeInTheDocument();
  });

  it('shows it immediately when a rating is already ON FILE — either state', () => {
    const ok = renderIsland(RATED_OK, OPEN_CASE);
    expect(screen.getByText(ASK)).toBeInTheDocument();
    ok.unmount();

    renderIsland(RATED_LOW, OPEN_CASE);
    expect(screen.getByText(ASK)).toBeInTheDocument();
  });

  it('REVEALS it in the same paint once the client rates, with no round trip', async () => {
    // ⚠ The whole point of the rule. A `router.refresh()` here would add a network hop and a
    // flash on a screen the user is actively abandoning.
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    renderIsland(UNRATED, OPEN_CASE);

    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(screen.getByText(ASK)).toBeInTheDocument());
    expect(screen.getByText('Thanks — saved.')).toBeInTheDocument();
  });

  it('does NOT reveal it when the write FAILS', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'nope' });
    const user = userEvent.setup();
    renderIsland(UNRATED, OPEN_CASE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
  });
});

describe('RateThenResolve — what each absence means', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders NO resolve prompt on a non-case context, even with a rating on file', () => {
    // A project kickoff has no case to resolve. Absent, not disabled.
    renderIsland(RATED_OK, null, 'meeting');
    expect(screen.getByText('Your rating for Amara')).toBeInTheDocument();
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sorted/i })).not.toBeInTheDocument();
  });

  it('renders NO rating block on a context with no reviewable engagement', () => {
    renderIsland(null, OPEN_CASE);
    expect(screen.queryByText(/How was/)).not.toBeInTheDocument();
    // …and the ordering rule then withholds the resolve prompt too: no rating can ever exist.
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
  });

  it('carries the context NOUN into the rating copy', () => {
    renderIsland(UNRATED, null, 'meeting');
    expect(screen.getByText('How was your meeting with Amara?')).toBeInTheDocument();
  });
});

describe('RateThenResolve — reviewWillBeAsked is derived, not read from the server', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * ⚠⚠ AC 7: resolving must not double-ask for a review already given on this screen. The
   * server's `reviewWillBeAsked` is computed BEFORE the user rates, so on the just-rated path it
   * would be stale-`true` and the dialog would promise an email `resolveReviewAsk` will not
   * send. The island derives it from `ratingExists`, which under the ordering rule is always
   * true where the prompt mounts — so the dialog's fourth bullet correctly never renders here.
   */
  const REVIEW_LINE = /short review link/i;

  it('omits the review-email promise for a rating already on file', async () => {
    const user = userEvent.setup();
    renderIsland(RATED_OK, OPEN_CASE);
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    expect(screen.getByRole('heading', { name: /Mark this case resolved/ })).toBeInTheDocument();
    expect(screen.queryByText(REVIEW_LINE)).not.toBeInTheDocument();
  });

  it('omits it on the JUST-RATED path too — where a stale server value would have lied', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    renderIsland(UNRATED, OPEN_CASE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.getByText(ASK)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    expect(screen.queryByText(REVIEW_LINE)).not.toBeInTheDocument();
  });
});

describe('RateThenResolve — rate then resolve, end to end', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures the review and closes the case from one paint', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    mockResolveCase.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderIsland(UNRATED, OPEN_CASE);

    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.getByText(ASK)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));

    await waitFor(() => expect(screen.getByText('Case closed.')).toBeInTheDocument());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'end_of_call', rating: 5 })
    );
    expect(mockResolveCase).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      source: 'end_of_call',
    });
    // The rating confirmation stays put alongside the closed-case line.
    expect(screen.getByText('Thanks — saved.')).toBeInTheDocument();
  });
});

/**
 * BAL-389 UX FIX — THE SECOND QUESTION IS ANNOUNCED.
 *
 * ⚠⚠ THE DEFECT: a screen-reader user rated, heard the toast, was left in the rating block's
 * confirmation, and was never told that a SECOND consequential question — the irreversible case
 * close — had just appeared underneath them.
 */
describe('RateThenResolve — the revealed question is announced (M3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the live region EMPTY at first paint, before anything is revealed', () => {
    // ⚠⚠ THE LOAD-BEARING DETAIL. `aria-live` is only honoured on a region that was ALREADY in
    // the accessibility tree when its contents changed, so a live wrapper that mounts WITH the
    // prompt announces nothing at all. The wrapper is unconditional; the content is conditional.
    const { container } = renderIsland(UNRATED, OPEN_CASE);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
  });

  it('reveals the prompt INSIDE that same region once the client rates', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    const { container } = renderIsland(UNRATED, OPEN_CASE);
    const live = container.querySelector('[aria-live="polite"]');

    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(screen.getByText(ASK)).toBeInTheDocument());
    expect(live?.textContent).toContain('Is this issue resolved?');
  });

  it('reserves NO dead gap for the empty region', () => {
    // ⚠ A flex `gap` counts the always-mounted-but-empty wrapper as a child and reserves 24px
    // under the rating on every render where the prompt is absent — which is most of them. The
    // spacing lives on the revealed block instead.
    const { container } = renderIsland(UNRATED, OPEN_CASE);
    expect(container.querySelector('.gap-6')).toBeNull();
  });
});

describe('RateThenResolve — accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['unrated + open case', UNRATED, OPEN_CASE],
    ['rated + open case', RATED_OK, OPEN_CASE],
    ['rated + closed case', RATED_OK, { ...OPEN_CASE, alreadyClosed: true }],
  ] as const)('has no violations — %s', async (_label, rating, resolve) => {
    const { container } = renderIsland(rating, resolve);
    expect(await axe(container)).toHaveNoViolations();
  });
});
