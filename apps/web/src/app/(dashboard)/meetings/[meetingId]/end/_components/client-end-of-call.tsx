import type { ClientEndOfCallView } from '@/lib/meetings/end-of-call-view-types';
import { EndOfCallLayout } from './end-of-call-layout';
import { RateThenResolve } from './rate-then-resolve';
import { OnwardCta } from './onward-cta';

/**
 * BAL-389 — the CLIENT composition. THE ONLY MODULE IN THIS FEATURE THAT NAMES THE RATING OR
 * THE RESOLVE PROMPT. That is layer 3 of the four-layer proof that the expert lens shows
 * neither: the branch is at COMPOSITION, never an `if (lens === 'expert')` that HIDES copy.
 *
 * ⚠ THE SLOT IS `undefined` WHEN IT WOULD RENDER NOTHING. Handing the layout an island that
 * returns an empty fragment still leaves a divider and a dead 24px gap on a card this small —
 * and on a request-grain context (no engagement to rate, no case to close) that is exactly what
 * would happen.
 *
 * ⚠⚠ THE NEUTRAL VARIANT IS A COPY BRANCH, NOT A SECOND SCREEN. When `meetingHeld` is `false`
 * (a FUTURE or CANCELLED meeting reached by hand-typed URL) the "complete" headline and the
 * artefact promise are both simply untrue: no consultation happened, so no recap and no receipt
 * are on their way. The card says so plainly instead of congratulating the viewer on a session
 * they have not had. The onward CTA STAYS — the recap route renders its own state for a meeting
 * with nothing in it, and removing the only way off the page would be the worse wrong.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off. The "complete" strings below are verbatim from
 * `.claude/design-references/end-of-call.jsx`; the neutral pair has no prototype counterpart
 * (the prototype has no concept of a meeting that has not happened) and is flagged for MJ.
 */
export function ClientEndOfCall({
  view,
}: Readonly<{ view: ClientEndOfCallView }>): React.JSX.Element {
  const { isCase, rating, resolve, meetingHeld } = view;
  const noun = isCase ? 'consultation' : 'meeting';
  // Two flat ternaries rather than one nested pair — SonarCloud S3358.
  const heldHeadline = isCase ? 'Consultation complete' : 'Meeting complete';
  const headline = meetingHeld ? heldHeadline : 'Nothing to wrap up yet';

  const hasPostCallActions = rating !== null || resolve !== null;

  return (
    <EndOfCallLayout
      headline={headline}
      counterpartyName={view.counterpartyName}
      durationMinutes={view.durationMinutes}
      reassurance={resolveReassurance(meetingHeld, isCase, noun)}
      recapState={view.recapState}
      sessionHeld={meetingHeld}
      onward={
        <OnwardCta
          meetingId={view.meetingId}
          lens="client"
          recapState={view.recapState}
          caseHref={view.caseHref}
        />
      }
      postCallActions={
        hasPostCallActions ? (
          <RateThenResolve
            meetingId={view.meetingId}
            rating={rating}
            resolve={resolve}
            counterpartyName={view.counterpartyName}
            noun={noun}
          />
        ) : undefined
      }
    />
  );
}

/**
 * The reassurance line, in three arms rather than a nested ternary (SonarCloud S3358).
 *
 * ⚠ THE NEUTRAL ARM PROMISES NOTHING. No recap, no receipt, no "we'll email you" — the whole
 * point is that there is no artefact to promise. It states what the viewer is looking at and
 * points at the one thing that is still true: whatever was arranged is untouched.
 */
function resolveReassurance(meetingHeld: boolean, isCase: boolean, noun: string): string {
  if (!meetingHeld) {
    return 'This ' + noun + " hasn't taken place, so there's nothing to wrap up here yet.";
  }
  if (isCase) {
    return "Your recap and receipt are on the way — we'll email you when they're ready. Nothing else needed here.";
  }
  return "Your recap is on the way — we'll email you when it's ready. Nothing else needed here.";
}
