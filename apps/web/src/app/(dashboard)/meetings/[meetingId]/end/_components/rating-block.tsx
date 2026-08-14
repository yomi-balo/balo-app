'use client';

import { useCallback, useId, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { REVIEW_BODY_MAX, isRating, type Rating } from '@balo/shared/reviews';
import { RatingInput } from '@/components/balo/rating-input';
import { StarRow } from '@/components/expert/profile/rating-stars';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { track, END_OF_CALL_EVENTS } from '@/lib/analytics';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';
import { submitEngagementReviewAction } from '@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review';
import { StateSwap } from './state-swap';

/**
 * BAL-389 — the rating capture, in BAL-390's THREE states.
 *
 *   `none`      → ask.
 *   `rated_ok`  → display it, and do NOT prompt.
 *   `rated_low` → display it and invite a revision.
 *
 * ⚠⚠ THE THRESHOLD IS NEVER RE-DERIVED HERE. This component switches on `state.kind` and
 * NOTHING ELSE — no `rating < 4`, no imported `LOW_RATING_THRESHOLD`, no literal `4`. The
 * boundary is decided once, by `resolveEndOfCallReviewState` inside `readEngagementReview`, with
 * the DEFAULT threshold. That injectable default-parameter seam is what satisfies the ticket's
 * "configurable, not hardcoded" AC: `platform_config` does not exist on `main`, and BAL-390's D2
 * docblock explicitly rejected the config approach. A source-scan assertion pins the absence of
 * the literal.
 *
 * ⚠ THE ASYMMETRY IS IN THE TRIGGER, NOT THE COPY. Only sub-threshold ratings are re-asked, but
 * the wording is neutral ("Has that changed?") and the stars move in BOTH directions. A one-way
 * ratchet in the copy would make the aggregate meaningless faster than the trigger alone does.
 *
 * ⚠⚠ THE NOTE IS PREFILLED FROM THE EXISTING BODY — a deliberate deviation from the prototype,
 * which initialises it to `''`. The write is an UPSERT, so submitting a revision from an empty
 * box would have written `body: null` and SILENTLY DELETED the client's own previous words.
 *
 * ⚠ `rated` vs `rating_revised` COMES FREE FROM THE WRITE PATH. `submitEngagementReviewAction`
 * returns `{ success: true, created: boolean }`, so the dimension cannot disagree with what the
 * database actually did — no extra read, no client-side guess.
 *
 * ⚠⚠ ON FAILURE THE STARS AND THE NOTE ARE **NOT** CLEARED, AND THE FAILURE IS **NOT** ONLY A
 * TOAST. The design reference has no error state; discarding someone's words because a request
 * failed is the worst possible reading of that silence — and so is an auto-dismissing toast as
 * the ONLY record of it. Sonner disappears after a few seconds, and a client who looked away
 * comes back to a form that looks exactly as it did before they pressed the button, with no way
 * to tell whether it saved. The message is therefore ALSO written inline, under the submit and
 * wired to it through `aria-describedby`, and it states the recovery explicitly: nothing they
 * wrote is lost. Both channels stay — the toast is the interrupt, the inline text is the record.
 *
 * ⚠⚠ REVISING IS NOT A ONE-WAY DOOR. "Change" / "Update my rating" used to be unexitable: the
 * only way back out of the capture form was to submit it. A ghost "Keep it as it is" sits beside
 * the submit and returns the block to its display state, resetting the draft and the note to the
 * server seeds — so backing out cannot half-edit anything.
 *
 * ⚠⚠ FOCUS IS MOVED ON EVERY IN-CARD SWAP, AND `StateSwap`'s `mode="wait"` IS WHY IT IS DONE
 * WITH CALLBACK REFS. Pressing "Save review" unmounts the button and renders a branch with ZERO
 * focusable elements; a keyboard or screen-reader user lost their place entirely and had to Tab
 * from the top of the document to find out what happened. Each destination therefore claims
 * focus as it mounts: the active star when the capture form opens, the confirmation container
 * (`tabIndex={-1}`) when the write lands, and the re-opened "Change" button when a revision is
 * abandoned. A `useEffect` or `requestAnimationFrame` would fire while the OUTGOING branch is
 * still the mounted one — see `StateSwap`'s docblock — so the ref is not a style preference.
 *
 * ⚠⚠ NEITHER HALF OF THE STAR CONTROL IS WRITTEN HERE — BOTH ARE SHIPPED COMPONENTS BAL-390
 * LEFT UNMOUNTED FOR THIS TICKET, AND RE-IMPLEMENTING EITHER IS THE BUG THIS COMMENT EXISTS TO
 * PREVENT.
 *   · CAPTURE → `components/balo/rating-input.tsx`. Its `size` prop is documented as
 *     "48 on the landing form, 40 at end-of-call", i.e. THIS surface was already in its brief.
 *     It carries an accessibility contract a hand-rolled row silently loses: a roving tabindex
 *     (the group is ONE tab stop, not five), Arrow/Home/End that move AND select with CLAMPING
 *     RATHER THAN WRAPPING (wrapping from 5 round to 1 turns a stray keypress into the opposite
 *     opinion), `role="radio"`/`aria-checked` instead of `aria-pressed`, a live `<output>` word
 *     label, hover preview, `disabled`, and `motion-reduce`.
 *   · READ-ONLY DISPLAY → `components/expert/profile/rating-stars.tsx`'s `StarRow`.
 * Using `RatingInput` also fixes an announcement split: it names each star
 * "5 out of 5 — Outstanding", so the SAME control no longer introduces itself two different
 * ways on `/review/{token}` and here.
 *
 * ⚠⚠ `size={40}` IS AN OWNER RULING, NOT AN OVERSIGHT. It is the figure `RatingInput`'s own prop
 * docblock names for this surface, it is the component's `MIN_TARGET_PX` floor, and the card
 * padding stays at `p-8` with it. Do not "fix" either to reach a bigger tap target.
 *
 * ⚠ `RatedDisplay` BELOW IS AN ACCESSIBLE-NAME WRAPPER, NOT A SECOND STAR IMPLEMENTATION.
 * `StarRow` paints a fractional fill and is deliberately decorative (no role, no label); the
 * `role="img"` + `aria-label` wrapper is what gives the read-only branches "Rated 3 out of 5"
 * as a single announcement instead of five silent glyphs.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off, and `RATING_LABELS` (rendered by `RatingInput`) is
 * likewise draft-pending-MJ and used AS SHIPPED. Do not re-author the star labels here.
 */

/**
 * The read-only echo: the SHIPPED `StarRow`, given one accessible name.
 *
 * ⚠ IT TAKES `number`, NOT `Rating`, ON PURPOSE. `EndOfCallReviewState.rating` is BAL-390's
 * shipped `number` (the 1–5 bound lives in the DB CHECK `review_rating_range`, which `tsc`
 * cannot see). Display is total over any number — `StarRow` clamps its own fill — so an
 * unexpected row paints something honest here instead of forcing an assertion.
 */
function RatedDisplay({ rating }: Readonly<{ rating: number }>): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={'Rated ' + rating + ' out of 5'}
      className="inline-flex justify-center"
    >
      <StarRow rating={rating} size={20} />
    </span>
  );
}

/** Which branch owns the card right now. Doubles as `StateSwap`'s key. */
type Branch = 'saved' | 'rated' | 'capture';

/** Where focus should land as the next branch mounts. `null` = leave focus alone. */
type FocusTarget = 'capture' | 'saved' | 'display' | null;

export function RatingBlock({
  rating,
  counterpartyName,
  noun,
  onRated,
}: Readonly<{
  rating: EndOfCallRatingView;
  /** The delivering expert's given name. Never an email address. */
  counterpartyName: string;
  /** `consultation` on a case, `meeting` otherwise — the design's own context rule. */
  noun: string;
  /** Fired ONLY on a successful write; it is what reveals the resolve prompt. */
  onRated: () => void;
}>): React.JSX.Element {
  const { state, engagementId, existingBody } = rating;
  const existingRating = state.kind === 'none' ? null : state.rating;
  /**
   * The CAPTURE seed, narrowed with the SHIPPED `isRating` guard rather than asserted. An
   * out-of-range row seeds an empty control and simply asks again — the only safe reading, and
   * the reason `RatingInput`'s `Rating | null` prop is worth satisfying honestly.
   */
  const seedRating: Rating | null =
    existingRating !== null && isRating(existingRating) ? existingRating : null;
  const seedNote = existingBody ?? '';

  const noteId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState<Rating | null>(seedRating);
  const [note, setNote] = useState<string>(seedNote);
  const [revising, setRevising] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * ⚠⚠ THE SAVED STATE ECHOES WHAT WAS **SENT**, NEVER THE LIVE DRAFT. Reading `draft` here
   * would show a rating that is not in the database: tap 5 → Save → tap 2 while the action is
   * in flight → the success state would claim 2 while the row (and BAL-422's aggregate) hold 5.
   * The value is captured at call time and echoed from here, exactly as `review-form.tsx` does
   * with `sentRating`. `RatingInput` is ALSO `disabled` while busy — belt and braces, because
   * the echo must be right even if a future edit removes the disable.
   */
  const [sentRating, setSentRating] = useState<Rating | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * ⚠ `null` ON FIRST PAINT, ALWAYS. Every value below is set by a user gesture, so the block
   * can never steal focus from the page on load — which is the failure mode an unconditional
   * focusing ref would ship.
   */
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);

  const startRevising = useCallback(() => {
    setFailure(null);
    setFocusTarget('capture');
    setRevising(true);
  }, []);

  /** m1 — the way back out. Both fields return to the SERVER seeds, so nothing is half-edited. */
  const keepAsIs = useCallback(() => {
    setDraft(seedRating);
    setNote(seedNote);
    setFailure(null);
    setFocusTarget('display');
    setRevising(false);
  }, [seedNote, seedRating]);

  /** Focus the roving-tabindex star — the ONE tab stop `RatingInput` exposes. */
  const captureRef = useCallback((node: HTMLDivElement | null) => {
    node?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
  }, []);

  const focusOnMount = useCallback((node: HTMLElement | null) => {
    node?.focus();
  }, []);

  const submit = useCallback(() => {
    if (draft === null) return;
    // Captured BEFORE the await, so the echo cannot drift from what the server was told.
    const sent: Rating = draft;
    setBusy(true);
    setFailure(null);
    const body = note.trim();
    submitEngagementReviewAction({
      engagementId,
      rating: sent,
      body: body.length === 0 ? undefined : body.slice(0, REVIEW_BODY_MAX),
      surface: 'end_of_call',
    })
      .then((result) => {
        if (result.success) {
          track(END_OF_CALL_EVENTS.ACTION, {
            action: result.created ? 'rated' : 'rating_revised',
            lens: 'client',
          });
          toast.success('Thanks — your rating is saved.');
          setFocusTarget('saved');
          setSentRating(sent);
          onRated();
          return;
        }
        // ⚠ The draft and the note SURVIVE — see the module docblock.
        toast.error(result.error);
        setFailure(result.error);
      })
      .catch(() => {
        toast.error('Something went wrong. Please try again.');
        setFailure('Something went wrong. Please try again.');
      })
      .finally(() => setBusy(false));
  }, [draft, engagementId, note, onRated]);

  let branch: Branch = 'capture';
  if (sentRating !== null) {
    branch = 'saved';
  } else if (state.kind !== 'none' && !revising) {
    branch = 'rated';
  }

  const heading =
    existingRating === null
      ? 'How was your ' + noun + ' with ' + counterpartyName + '?'
      : 'How was this one with ' + counterpartyName + '?';

  /**
   * ⚠ THE ONLY DIFFERENCE BETWEEN THE TWO READ-ONLY STATES, IN ONE PLACE. `rated_ok` displays
   * and does NOT prompt; `rated_low` displays and INVITES a revision — a louder outline button
   * under "Has that changed?". Three ternaries on the same discriminant across the JSX is how
   * those two presentations drift apart.
   */
  const invitesRevision = state.kind === 'rated_low';
  const revisionCta = invitesRevision
    ? { label: 'Update my rating', variant: 'outline' as const, className: 'mt-2 min-h-11 text-sm' }
    : {
        label: 'Change',
        variant: 'ghost' as const,
        className: 'text-muted-foreground mt-2 min-h-11 text-xs',
      };

  return (
    <StateSwap swapKey={branch} className="flex w-full flex-col items-center">
      {branch === 'saved' && sentRating !== null && (
        <div
          ref={focusTarget === 'saved' ? focusOnMount : undefined}
          tabIndex={-1}
          className="flex flex-col items-center gap-2 outline-none"
        >
          <p className="text-success flex items-center gap-2 text-sm">
            <Check className="h-4 w-4" aria-hidden="true" />
            Thanks — saved.
          </p>
          <RatedDisplay rating={sentRating} />
        </div>
      )}

      {branch === 'rated' && state.kind !== 'none' && (
        <div className="flex flex-col items-center">
          {/* ⚠ m5 — TENSE-NEUTRAL. "You rated {name} after your last {noun}" is factually WRONG on
              the likeliest repeat path (a rating given sixty seconds ago, on THIS consultation)
              and reads oddly on a one-off kickoff. "Your rating for {name}" is true in every
              case. FLAGGED FOR MJ. */}
          <p className="text-muted-foreground mb-1.5 text-sm">
            {'Your rating for ' + counterpartyName}
          </p>
          <RatedDisplay rating={state.rating} />
          {invitesRevision && (
            <p className="text-foreground mt-3 text-sm font-medium">Has that changed?</p>
          )}
          <Button
            type="button"
            ref={focusTarget === 'display' ? focusOnMount : undefined}
            variant={revisionCta.variant}
            onClick={startRevising}
            className={revisionCta.className}
          >
            {revisionCta.label}
          </Button>
        </div>
      )}

      {branch === 'capture' && (
        <div
          ref={focusTarget === 'capture' ? captureRef : undefined}
          className="flex w-full flex-col items-center"
        >
          {/* ⚠ m6 — A HEADING, NOT A PARAGRAPH. Two consequential questions sit on this card and
              a screen-reader user could not jump between them. Visual weight is unchanged. */}
          <h2 className="text-foreground mb-2 text-sm font-medium">{heading}</h2>
          {/* ⚠ `size={40}` is the end-of-call figure `RatingInput`'s own prop docblock names, and
              `disabled={busy}` is why the in-flight selection cannot move under the request. */}
          <RatingInput
            value={draft}
            onChange={setDraft}
            size={40}
            disabled={busy}
            label={heading}
            placeholder="Tap a star to rate"
          />

          {draft !== null && (
            <div className="mt-3 w-full">
              <label htmlFor={noteId} className="sr-only">
                Add a line about this {noun}
              </label>
              <Textarea
                id={noteId}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={REVIEW_BODY_MAX}
                placeholder="Add a line? (Optional)"
                className="resize-none rounded-xl text-sm"
              />
              <div className="mt-2 flex flex-col gap-2">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={submit}
                  aria-describedby={failure === null ? undefined : errorId}
                  className="min-h-11 w-full gap-2 text-sm font-medium"
                >
                  {busy && (
                    <Loader2
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {existingRating === null ? 'Save review' : 'Update review'}
                </Button>
                {revising && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={keepAsIs}
                    className="text-muted-foreground min-h-11 w-full text-sm"
                  >
                    Keep it as it is
                  </Button>
                )}
              </div>
              {failure !== null && (
                <p id={errorId} className="text-destructive mt-2 text-sm leading-relaxed">
                  {failure + ' Nothing you wrote is lost — your rating and note are still here.'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </StateSwap>
  );
}
