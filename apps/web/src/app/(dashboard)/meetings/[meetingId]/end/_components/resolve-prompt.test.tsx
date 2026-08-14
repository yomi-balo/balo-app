import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type { EndOfCallResolveView } from '@/lib/meetings/end-of-call-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

// ⚠ `'wait'` because this prompt swaps its own content in place and the acknowledgement claims
// focus as it mounts — see `@/test/motion-stub` for why the passthrough stub hides that bug.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub({ animatePresenceMode: 'wait' });
});

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

const mockResolveCase = vi.fn();
vi.mock('../../_actions/resolve-case', () => ({
  resolveCaseAction: (...a: unknown[]) => mockResolveCase(...a),
}));

import { ResolvePrompt } from './resolve-prompt';

const OPEN: EndOfCallResolveView = {
  engagementId: ENGAGEMENT_ID,
  requesterLabel: null,
  alreadyClosed: false,
  expertShortName: 'Amara',
};

function renderPrompt(resolve: EndOfCallResolveView = OPEN, reviewWillBeAsked = false) {
  return render(
    <ResolvePrompt meetingId={MEETING_ID} resolve={resolve} reviewWillBeAsked={reviewWillBeAsked} />
  );
}

describe('ResolvePrompt — the ask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks once, with two answers', () => {
    renderPrompt();
    expect(screen.getByText('Is this issue resolved?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Yes, it's sorted" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
  });

  it('asks it as a HEADING, so it can be jumped to (m6)', () => {
    // ⚠ Two consequential questions sit on this card — the rating and this one. As `<p>`
    // elements a screen-reader user could not move between them. Visual weight is unchanged.
    renderPrompt();
    expect(screen.getByRole('heading', { name: 'Is this issue resolved?' })).toBeInTheDocument();
  });

  it('is NEVER a single unguarded tap — the first click only confirms', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    // ⚠ THE LOAD-BEARING NEGATIVE. This is the one irreversible action on the screen.
    expect(mockResolveCase).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Mark this case resolved/ })).toBeInTheDocument();
  });

  it('closes only from inside the confirmation, and with source=end_of_call', async () => {
    mockResolveCase.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));

    await waitFor(() =>
      expect(mockResolveCase).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        source: 'end_of_call',
      })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('Case resolved — nice work.');
  });

  it('returns to the ask when the confirmation is cancelled, with no mutation', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    // ⚠ "Go back", NOT "Not yet" — the dialog's cancel is a DIFFERENT answer from the prompt's,
    // and one label meaning two things one tap apart is what this rename fixed.
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: /Mark this case resolved/ })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByText('Is this issue resolved?')).toBeInTheDocument();
    expect(mockResolveCase).not.toHaveBeenCalled();
  });

  it('never uses ONE label for two different answers in the same flow', async () => {
    // ⚠⚠ R1's second half. The prompt asks "Is this issue resolved?" with a "Not yet" answer;
    // "Yes, it's sorted" opens a confirmation that used to carry a SECOND "Not yet" one tap
    // later, meaning only "dismiss this dialog". Two meanings, same words, same flow.
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not yet' })).not.toBeInTheDocument();
  });

  it('surfaces a refusal verbatim and stays open', async () => {
    mockResolveCase.mockResolvedValue({ success: false, error: 'This case is already resolved.' });
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('This case is already resolved.')
    );
    expect(screen.queryByText('Case closed.')).not.toBeInTheDocument();
  });
});

/**
 * BAL-389 UX FIX — "Not yet" USED TO BE A DEAD BUTTON.
 *
 * ⚠⚠ THE DEFECT: it called a handler that set the step to the step it was already on, so tapping
 * it did LITERALLY NOTHING. The question just sat there, apparently having ignored the answer —
 * the worst possible reading of a control whose entire promise is that declining costs nothing.
 *
 * ⚠⚠ THE RULE IS UNCHANGED AND MUST STAY UNCHANGED. Acknowledging is SESSION-LOCAL component
 * state: no server call, no persistence, no re-prompt, no dismissal record. The recap's model
 * (which DOES write) must not leak onto a surface whose answer is "nothing happens".
 */
describe('ResolvePrompt — "Not yet" answers in place, and writes NOTHING', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces the prompt with a one-line acknowledgement naming where the action still lives', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));

    await waitFor(() =>
      expect(
        screen.getByText('No problem — you can mark it resolved any time from the case.')
      ).toBeInTheDocument()
    );
    // The question is ANSWERED, so it goes — it is not asked a second time in the same session.
    expect(screen.queryByText('Is this issue resolved?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Yes, it's sorted" })).not.toBeInTheDocument();
  });

  it('PERSISTS NOTHING — no action, no toast, no dismissal record', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(screen.getByText(/No problem/)).toBeInTheDocument());

    expect(mockResolveCase).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('takes focus, so the keyboard user is not dropped to the top of the document', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'No problem — you can mark it resolved any time from the case.'
      )
    );
  });

  it('has no accessibility violations in the acknowledged state', async () => {
    const user = userEvent.setup();
    const { container } = renderPrompt();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(screen.getByText(/No problem/)).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ResolvePrompt — an outstanding expert request is CONTEXT, not an approval state', () => {
  beforeEach(() => vi.clearAllMocks());

  const REQUESTED: EndOfCallResolveView = { ...OPEN, requesterLabel: 'Amara @ CloudPeak' };

  it('prefixes ONE retrospective attribution line and keeps the same ask', () => {
    renderPrompt(REQUESTED);
    expect(screen.getByText('Amara @ CloudPeak thinks this one is sorted')).toBeInTheDocument();
    // ⚠ STILL THE SAME PROMPT. No approve/decline pair, no "pending", no "awaiting".
    expect(screen.getByRole('button', { name: "Yes, it's sorted" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Approve|Decline|Reject/ })
    ).not.toBeInTheDocument();
  });

  it('renders no pending-approval language anywhere', () => {
    const { container } = renderPrompt(REQUESTED);
    expect(container.textContent).not.toMatch(/pending|awaiting|approval|request to close/i);
  });

  it('omits the line entirely when nobody has asked', () => {
    const { container } = renderPrompt(OPEN);
    expect(container.textContent).not.toContain('thinks this one is sorted');
  });
});

describe('ResolvePrompt — the done state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('SURVIVES the post-close refresh, driven off the local step', async () => {
    // ⚠ `ResolveDialog` calls `router.refresh()` in its `finally`. The success state has to
    // stay on screen: unmounting after the one irreversible action leaves the milestone
    // unconfirmed.
    mockResolveCase.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderPrompt();
    await user.click(screen.getByRole('button', { name: "Yes, it's sorted" }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));

    await waitFor(() => expect(screen.getByText('Case closed.')).toBeInTheDocument());
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.queryByText('Is this issue resolved?')).not.toBeInTheDocument();
  });

  it('renders directly for a case that is ALREADY closed on the server', () => {
    renderPrompt({ ...OPEN, alreadyClosed: true });
    expect(screen.getByText('Case closed.')).toBeInTheDocument();
    expect(screen.queryByText('Is this issue resolved?')).not.toBeInTheDocument();
  });

  it('states ONLY the review-is-saved line — the other branch is unreachable here', () => {
    // ⚠ The prototype's `rated ? … : "We'll email you a short review request."` cannot reach its
    // second arm on this screen: the prompt only mounts once a rating exists, and
    // `resolveReviewAsk` skips the token in exactly that case, so the close email genuinely
    // omits its review block. A branch no code path can enter is dead copy; the conditional
    // legitimately lives in `WrapUpCard` / `ResolveDialog`, which are reached without a rating.
    const { container } = renderPrompt({ ...OPEN, alreadyClosed: true });
    expect(screen.getByText('Your review is saved, so nothing else to do.')).toBeInTheDocument();
    expect(container.textContent).not.toContain('review request');
    expect(container.textContent).not.toMatch(/we.ll email you a short review/i);
  });
});

describe('ResolvePrompt — accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['ask', OPEN],
    ['requested', { ...OPEN, requesterLabel: 'Amara @ CloudPeak' }],
    ['done', { ...OPEN, alreadyClosed: true }],
  ] as const)('has no violations — %s', async (_label, resolve) => {
    const { container } = renderPrompt(resolve);
    expect(await axe(container)).toHaveNoViolations();
  });
});
