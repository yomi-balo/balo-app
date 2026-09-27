import {
  CALL_STILL_OPEN_HEADLINE,
  CASE_CLOSED_HEADLINE,
  expertCallStillOpenBody,
  expertCaseClosedBody,
} from '@/lib/meetings/end-of-call-copy';
import type { ExpertEndOfCallView } from '@/lib/meetings/end-of-call-view-types';
import { EndOfCallLayout } from './end-of-call-layout';
import { OnwardCta } from './onward-cta';

/**
 * BAL-389 — the EXPERT composition. A PURE DELEGATION: it passes NO post-call slot, and it
 * names nothing rating- or resolve-shaped.
 *
 * ⚠⚠ THIS FILE IS THE ACCEPTANCE CRITERION "the expert lens shows no rating and no resolve
 * action", MADE STRUCTURAL. There is no conditional here to get wrong, because the view it
 * receives HAS NO `rating` AND NO `resolve` FIELD (the union arm omits them), the loader never
 * even READ that data on this path, and nothing this file reaches ever mentions the island.
 * `expert-end-of-call.test.tsx` is a SOURCE SCAN over every file in this directory that proves
 * it — a render test could only ever prove "not for THIS fixture".
 *
 * ⚠ THE COUNTERPARTY IS THE CLIENT **COMPANY**, NOT A PERSON — a deliberate deviation from the
 * prototype's `CLIENT = { name: 'Jordan' }` fixture. CLAUDE.md's attribution rule makes
 * client-side rights sit on COMPANY membership and survive individual departures, so there is
 * no single client person to name. The copy template is unchanged; only what fills `{name}`
 * differs, and `resolveCounterparty` has resolved it already. Shipped precedent: BAL-388's
 * recap party card.
 *
 * ⚠⚠ THE NEUTRAL VARIANT APPLIES HERE TOO, AND IT IS NOT A CLIENT-SIDE CONCERN LEAKING ACROSS.
 * "Nice session" over a success tick, plus "your notes and payout summary are on the way", is
 * exactly as untrue for a FUTURE or CANCELLED meeting as the client copy was — arguably worse,
 * since it names a PAYOUT for work nobody has done. Same predicate, same branch, same neutral
 * headline. It remains a pure delegation: the branch is two string choices, not a slot.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off. The "Nice session" pair is verbatim from
 * `.claude/design-references/end-of-call.jsx`; the neutral pair has no prototype counterpart.
 */
export function ExpertEndOfCall({
  view,
}: Readonly<{ view: ExpertEndOfCallView }>): React.JSX.Element {
  const { meetingHeld, beganEarly, caseClosure } = view;
  const notHeldHeadline = beganEarly ? CALL_STILL_OPEN_HEADLINE : 'Nothing to wrap up yet';
  const heldHeadline = meetingHeld ? 'Nice session' : notHeldHeadline;
  return (
    <EndOfCallLayout
      headline={caseClosure === null ? heldHeadline : CASE_CLOSED_HEADLINE}
      counterpartyName={view.counterpartyName}
      durationMinutes={view.durationMinutes}
      reassurance={resolveBody(view)}
      recapState={view.recapState}
      sessionHeld={meetingHeld}
      caseClosed={caseClosure !== null}
      onward={
        <OnwardCta
          meetingId={view.meetingId}
          lens="expert"
          recapState={view.recapState}
          caseHref={view.caseHref}
          caseClosed={caseClosure !== null}
        />
      }
    />
  );
}

/**
 * The body line, in flat branches rather than a nested ternary (SonarCloud S3358). The voided no-show's
 * closed-case sentence promises no payout, recap or receipt; the held arm keeps the design's payout-summary line.
 */
function resolveBody(view: ExpertEndOfCallView): string {
  if (view.caseClosure !== null) {
    return expertCaseClosedBody(view.caseClosure);
  }
  if (view.meetingHeld) {
    return "Your notes and payout summary are on the way — we'll email you when your recap is ready.";
  }
  if (view.beganEarly) {
    return expertCallStillOpenBody(view.counterpartyName);
  }
  return "This session hasn't taken place, so there's nothing to wrap up here yet.";
}
