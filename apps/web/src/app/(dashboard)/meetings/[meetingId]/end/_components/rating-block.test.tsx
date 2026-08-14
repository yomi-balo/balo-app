import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import { render, screen, waitFor } from '@/test/utils';
import { track, END_OF_CALL_EVENTS } from '@/lib/analytics';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

/**
 * ⚠⚠ `animatePresenceMode: 'wait'` IS LOAD-BEARING HERE, NOT COSMETIC. The block swaps its own
 * content in place after a save, and BAL-389's UX pass added focus management across that swap.
 * The default passthrough stub mounts the incoming branch in the SAME commit as the state
 * change, which makes a broken focus handoff look correct; `'wait'` reproduces the real ordering
 * where the outgoing branch is still the mounted one. See `@/test/motion-stub`.
 */
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub({ animatePresenceMode: 'wait' });
});

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

const mockSubmit = vi.fn();
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: (...a: unknown[]) => mockSubmit(...a),
}));

import { RatingBlock } from './rating-block';

const NONE: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'none' },
  existingBody: null,
};
const RATED_OK: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_ok', rating: 5 },
  existingBody: 'Sorted it in one go.',
};
const RATED_LOW: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_low', rating: 3 },
  existingBody: 'Nearly there.',
};

function renderBlock(rating: EndOfCallRatingView, onRated = vi.fn()) {
  return {
    onRated,
    ...render(
      <RatingBlock rating={rating} counterpartyName="Amara" noun="consultation" onRated={onRated} />
    ),
  };
}

describe('RatingBlock — BAL-390 state 1: no rating yet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ASKS, with interactive stars', () => {
    renderBlock(NONE);
    expect(screen.getByText('How was your consultation with Amara?')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('reveals the note and the submit only once a star is picked', async () => {
    const user = userEvent.setup();
    renderBlock(NONE);
    expect(screen.queryByRole('button', { name: 'Save review' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^5 out of 5/ }));
    expect(screen.getByRole('button', { name: 'Save review' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Add a line? (Optional)')).toBeInTheDocument();
  });

  it('uses the SHIPPED star labels rather than inventing its own', () => {
    // `RATING_LABELS` is draft-pending-MJ and must be used as shipped.
    renderBlock(NONE);
    expect(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' })).toBeInTheDocument();
  });
});

/**
 * The component under test, read from disk for the two STRUCTURAL pins below. The candidate
 * list is mandatory: CI runs web vitest from the REPO ROOT while a developer runs it from
 * `apps/web`, and a path that resolves to nothing passes every assertion vacuously (memory
 * `reference_web_server_disk_asset_cwd`).
 */
const BLOCK = 'app/(dashboard)/meetings/[meetingId]/end/_components/rating-block.tsx';
const blockPath = resolveRouteDir(['src/' + BLOCK, 'apps/web/src/' + BLOCK]);

describe('RatingBlock — it MOUNTS the shipped controls rather than re-implementing them', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * ⚠⚠ BAL-390 shipped BOTH halves and left them unmounted FOR THIS TICKET. These assertions
   * pin the CONTRACTS a hand-rolled star row silently loses — each one is a real regression if
   * someone re-inlines the control.
   */

  it('exposes ONE tab stop, not five — the roving-tabindex contract', async () => {
    const user = userEvent.setup();
    renderBlock(NONE);
    const stars = screen.getAllByRole('radio');
    await user.tab();
    expect(stars[0]).toHaveFocus();
    // The next Tab must LEAVE the group entirely rather than land on star 2.
    await user.tab();
    expect(stars.some((star) => star === document.activeElement)).toBe(false);
  });

  it('CLAMPS at 5 on ArrowRight rather than wrapping round to 1', async () => {
    // ⚠ Wrapping on a rating scale turns a stray keypress into the opposite opinion.
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('CLAMPS at 1 on ArrowLeft rather than wrapping round to 5', async () => {
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" }));
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('announces each star the SAME WAY as the magic-link landing does', () => {
    // ⚠ One control, one accessible-name format. `5 — Outstanding` here and
    // `5 out of 5 — Outstanding` on `/review/{token}` would be the same control introducing
    // itself two different ways on two surfaces.
    renderBlock(NONE);
    for (const name of [
      "1 out of 5 — Didn't help",
      '2 out of 5 — Some way off',
      '3 out of 5 — Did the job',
      '4 out of 5 — Really helpful',
      '5 out of 5 — Outstanding',
    ]) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('carries a LIVE WORD LABEL, so a mis-tap is legible before it is committed', async () => {
    const user = userEvent.setup();
    renderBlock(NONE);
    expect(screen.getByText('Tap a star to rate')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '2 out of 5 — Some way off' }));
    expect(screen.getByText('2 — Some way off')).toBeInTheDocument();
  });

  it('guards the guard — the component source was actually found', () => {
    expect(blockPath).not.toBe('');
  });

  it('IMPORTS both halves and declares neither', () => {
    // ⚠ A local `function StarRow` would also SHADOW the shipped export of that exact name in
    // this same app, which is how the re-implementation went unnoticed the first time.
    const code = codeLinesOf(readFileSync(blockPath, 'utf8'));
    expect(code).toContain("from '@/components/balo/rating-input'");
    expect(code).toContain("from '@/components/expert/profile/rating-stars'");
    expect(code).not.toContain('function StarRow');
    expect(code).not.toContain('aria-pressed');
  });
});

describe('RatingBlock — BAL-390 state 2: rated at or above the threshold', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DISPLAYS the rating and does NOT prompt', () => {
    renderBlock(RATED_OK);
    expect(screen.getByText('Your rating for Amara')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated 5 out of 5' })).toBeInTheDocument();
    // ⚠ THE LOAD-BEARING NEGATIVE: a satisfied client is not re-asked.
    expect(screen.queryByText(/Has that changed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/How was/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('opens the capture form on Change, with the existing rating preselected', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_OK);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText('How was this one with Amara?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

describe('RatingBlock — BAL-390 state 3: rated below the threshold', () => {
  beforeEach(() => vi.clearAllMocks());

  it('displays it and invites a revision in NEUTRAL copy', () => {
    // ⚠ The asymmetry is in the TRIGGER, not the copy. A one-way ratchet in the wording would
    // make the aggregate meaningless faster than the trigger alone does.
    renderBlock(RATED_LOW);
    expect(screen.getByText('Your rating for Amara')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated 3 out of 5' })).toBeInTheDocument();
    expect(screen.getByText('Has that changed?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update my rating' })).toBeInTheDocument();
  });

  it('states the rating TENSE-NEUTRALLY — never "after your last consultation"', () => {
    /**
     * ⚠ m5. "You rated {name} after your last {noun}" is factually WRONG on the likeliest
     * repeat-visit path: it describes a rating given sixty seconds ago on THIS consultation, and
     * it reads oddly on a one-off kickoff where there is no "last" anything. Both read-only
     * states now use one line that is true in every case. FLAGGED FOR MJ.
     */
    const { container, unmount } = renderBlock(RATED_LOW);
    expect(container.textContent).not.toContain('after your last');
    unmount();

    const ok = renderBlock(RATED_OK);
    expect(ok.container.textContent).not.toContain('after your last');
    expect(screen.getByText('Your rating for Amara')).toBeInTheDocument();
  });

  it('lets the stars move in BOTH directions on revision', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    await user.click(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" }));
    expect(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

describe('RatingBlock — the write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits with surface=end_of_call, the seam BAL-390 declared for this ticket', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '4 out of 5 — Really helpful' }));
    await user.type(screen.getByPlaceholderText('Add a line? (Optional)'), 'Really useful.');
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        rating: 4,
        body: 'Really useful.',
        surface: 'end_of_call',
      })
    );
  });

  it('omits an empty body rather than writing a blank string', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ body: undefined }))
    );
  });

  it('PREFILLS the note on a revision, so an upsert cannot silently delete the words', async () => {
    // ⚠ A DELIBERATE DEVIATION FROM THE PROTOTYPE, which starts the textarea empty. The write is
    // an UPSERT: submitting from an empty box would have written `body: null`.
    mockSubmit.mockResolvedValue({ success: true, created: false });
    const user = userEvent.setup();
    renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    expect(screen.getByPlaceholderText('Add a line? (Optional)')).toHaveValue('Nearly there.');
    await user.click(screen.getByRole('button', { name: 'Update review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Nearly there.', rating: 3 })
      )
    );
  });

  it("maps created:true to 'rated' and created:false to 'rating_revised'", async () => {
    // ⚠ THE DIMENSION COMES FREE FROM THE WRITE PATH — it cannot disagree with what the DB did.
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    const first = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(END_OF_CALL_EVENTS.ACTION, {
        action: 'rated',
        lens: 'client',
      })
    );
    first.unmount();

    vi.clearAllMocks();
    mockSubmit.mockResolvedValue({ success: true, created: false });
    renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    await user.click(screen.getByRole('button', { name: 'Update review' }));
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(END_OF_CALL_EVENTS.ACTION, {
        action: 'rating_revised',
        lens: 'client',
      })
    );
  });

  it('toasts, confirms in place, and fires onRated ONLY on success', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    const { onRated } = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
    expect(mockToastSuccess).toHaveBeenCalledWith('Thanks — your rating is saved.');
    expect(onRated).toHaveBeenCalledOnce();
  });

  it('toasts the returned copy verbatim on failure, and KEEPS the stars and the note', async () => {
    // ⚠ The design reference has no error state. Discarding someone's words because a request
    // failed is the worst possible reading of that silence.
    mockSubmit.mockResolvedValue({ success: false, error: 'That engagement could not be found.' });
    const user = userEvent.setup();
    const { onRated } = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '4 out of 5 — Really helpful' }));
    await user.type(screen.getByPlaceholderText('Add a line? (Optional)'), 'Kept words.');
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('That engagement could not be found.')
    );
    expect(onRated).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Add a line? (Optional)')).toHaveValue('Kept words.');
    expect(screen.getByRole('radio', { name: '4 out of 5 — Really helpful' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.queryByText('Thanks — saved.')).not.toBeInTheDocument();
  });

  it('toasts a generic failure when the action REJECTS', async () => {
    mockSubmit.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    const { onRated } = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Something went wrong. Please try again.')
    );
    expect(onRated).not.toHaveBeenCalled();
  });
});

describe('RatingBlock — the in-flight race', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * ⚠⚠ THE SUCCESS STATE MUST ECHO WHAT WAS **SENT**, NOT THE LIVE DRAFT. Without both halves
   * of the fix the sequence `tap 5 → Save → tap 2 mid-flight → resolve` renders "Rated 2 out of
   * 5" while the database — and BAL-422's aggregate — hold 5. Two independent guards, pinned
   * separately so removing either one fails here.
   */

  it('DISABLES the stars while the write is in flight', async () => {
    let release: (value: { success: true; created: boolean }) => void = () => {};
    mockSubmit.mockReturnValue(
      new Promise<{ success: true; created: boolean }>((resolve) => {
        release = resolve;
      })
    );
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    for (const star of screen.getAllByRole('radio')) {
      expect(star).toBeDisabled();
    }
    release({ success: true, created: true });
    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
  });

  it('echoes the SENT rating even when the selection is changed mid-flight', async () => {
    let release: (value: { success: true; created: boolean }) => void = () => {};
    mockSubmit.mockReturnValue(
      new Promise<{ success: true; created: boolean }>((resolve) => {
        release = resolve;
      })
    );
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    // The attempt the race needs. It is a no-op today (the control is disabled above), and the
    // echo below must be correct REGARDLESS — that is the point of capturing the sent value.
    await user.click(screen.getByRole('radio', { name: '2 out of 5 — Some way off' }));
    release({ success: true, created: true });

    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ rating: 5 }));
    expect(screen.getByRole('img', { name: 'Rated 5 out of 5' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Rated 2 out of 5' })).not.toBeInTheDocument();
  });

  it('renders the SENT value structurally — the saved branch never reads the live draft', () => {
    // ⚠ THE PIN THAT SURVIVES THE DISABLE. With the stars disabled mid-flight the DOM test above
    // cannot distinguish "echoes what was sent" from "echoes a draft that happened not to move".
    // This one can: re-introducing `rating={draft}` in the saved branch fails here immediately.
    const code = codeLinesOf(readFileSync(blockPath, 'utf8'));
    expect(code).toContain('<RatedDisplay rating={sentRating} />');
    expect(code).not.toContain('rating={draft}');

    // …and the capture control itself carries the disable, not merely the submit button.
    const opensAt = code.indexOf('<RatingInput');
    expect(opensAt).toBeGreaterThan(-1);
    expect(code.slice(opensAt, code.indexOf('/>', opensAt))).toContain('disabled={busy}');
  });
});

/**
 * BAL-389 UX FIX — FOCUS SURVIVES EVERY IN-CARD SWAP.
 *
 * ⚠⚠ THE DEFECT: pressing "Save review" unmounted the button and rendered a branch containing
 * ZERO focusable elements. A keyboard or screen-reader user was silently dropped to `<body>` and
 * had to Tab from the top of the DOCUMENT to discover what had happened — on the exact screen
 * that had just told them everything was fine. "Change" / "Update my rating" had the mirror
 * problem: the star control mounted and nobody was standing on it.
 */
describe('RatingBlock — focus is never dropped on an in-card swap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lands on the ACTIVE star when the capture form opens from Change', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_OK);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' })).toHaveFocus()
    );
  });

  it('lands on the ACTIVE star from Update my rating too', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '3 out of 5 — Did the job' })).toHaveFocus()
    );
  });

  it('moves to the confirmation once the write lands — never to <body>', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain('Thanks — saved.');
  });

  it('STEALS NOTHING on first paint — every move is a response to a gesture', () => {
    // The failure mode of an unconditional focusing ref: the card grabs focus from the page the
    // moment it renders, on a screen the user may be about to close.
    renderBlock(NONE);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('RatingBlock — revising is not a one-way door (m1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers a way back out beside the submit, and only while revising', async () => {
    const user = userEvent.setup();
    const fresh = renderBlock(NONE);
    // ⚠ NOT on the first-ever rating: there is no prior state to keep.
    await user.click(screen.getByRole('radio', { name: '4 out of 5 — Really helpful' }));
    expect(screen.queryByRole('button', { name: 'Keep it as it is' })).not.toBeInTheDocument();
    fresh.unmount();

    renderBlock(RATED_OK);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Keep it as it is' })).toBeInTheDocument();
  });

  it('returns to the display state and RESETS both fields to the server seeds', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    await user.click(screen.getByRole('radio', { name: "1 out of 5 — Didn't help" }));
    await user.clear(screen.getByPlaceholderText('Add a line? (Optional)'));
    await user.type(screen.getByPlaceholderText('Add a line? (Optional)'), 'Changed my mind.');

    await user.click(screen.getByRole('button', { name: 'Keep it as it is' }));

    // Back on the display state, showing the SERVER value — the abandoned edit is gone.
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Rated 3 out of 5' })).toBeInTheDocument()
    );
    expect(mockSubmit).not.toHaveBeenCalled();

    // …and re-opening it shows the seeds, not the abandoned draft.
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    expect(screen.getByPlaceholderText('Add a line? (Optional)')).toHaveValue('Nearly there.');
    expect(screen.getByRole('radio', { name: '3 out of 5 — Did the job' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('returns focus to the control that opened the form', async () => {
    const user = userEvent.setup();
    renderBlock(RATED_OK);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'Keep it as it is' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveFocus());
  });
});

describe('RatingBlock — a failed write leaves a RECORD, not just a toast (m2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the refusal inline, states the recovery, and describes the submit', async () => {
    // ⚠ Sonner auto-dismisses. A client who looked away came back to a form that looked exactly
    // as it did before they pressed the button, with no way to tell whether it saved.
    mockSubmit.mockResolvedValue({ success: false, error: 'That engagement could not be found.' });
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '4 out of 5 — Really helpful' }));
    await user.type(screen.getByPlaceholderText('Add a line? (Optional)'), 'Kept words.');
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    const submit = await screen.findByRole('button', { name: 'Save review' });
    await waitFor(() => expect(submit).toHaveAccessibleDescription(/could not be found/));
    expect(submit).toHaveAccessibleDescription(/Nothing you wrote is lost/);
    // The toast stays too — it is the interrupt; the inline text is the record.
    expect(mockToastError).toHaveBeenCalledWith('That engagement could not be found.');
  });

  it('surfaces a REJECTION inline as well, not only as a toast', async () => {
    mockSubmit.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() =>
      expect(screen.getByText(/Something went wrong\. Please try again\./)).toBeInTheDocument()
    );
  });

  it('clears the inline error on the next attempt rather than stacking failures', async () => {
    mockSubmit.mockResolvedValueOnce({ success: false, error: 'Temporary problem.' });
    mockSubmit.mockResolvedValueOnce({ success: true, created: true });
    const user = userEvent.setup();
    renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.getByText(/Temporary problem\./)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
    expect(screen.queryByText(/Temporary problem\./)).not.toBeInTheDocument();
  });
});

describe('RatingBlock — accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks its question as a HEADING, so it can be jumped to (m6)', () => {
    // ⚠ Two consequential questions sit on this card. As `<p>` elements a screen-reader user
    // could not move between them at all. Visual weight is deliberately unchanged.
    renderBlock(NONE);
    expect(
      screen.getByRole('heading', { name: 'How was your consultation with Amara?' })
    ).toBeInTheDocument();
  });

  it.each([
    ['none', NONE],
    ['rated_ok', RATED_OK],
    ['rated_low', RATED_LOW],
  ] as const)('has no violations — %s', async (_label, rating) => {
    const { container } = renderBlock(rating);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('labels the note textarea for screen readers', async () => {
    const user = userEvent.setup();
    const { container } = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '3 out of 5 — Did the job' }));
    expect(
      screen.getByRole('textbox', { name: /Add a line about this consultation/ })
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the SAVED state', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    const { container } = renderBlock(NONE);
    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.getByText('Thanks — saved.')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations while REVISING, with the inline error showing', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'Temporary problem.' });
    const user = userEvent.setup();
    const { container } = renderBlock(RATED_LOW);
    await user.click(screen.getByRole('button', { name: 'Update my rating' }));
    await user.click(screen.getByRole('button', { name: 'Update review' }));
    await waitFor(() => expect(screen.getByText(/Temporary problem\./)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Keep it as it is' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
