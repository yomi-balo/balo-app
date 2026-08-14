import Link from 'next/link';
import { Link2Off } from 'lucide-react';

/**
 * The SINGLE generic bail-out for the review landing (BAL-390 §6.2).
 *
 * ⚠ EVERY inactive outcome renders EXACTLY this, with no differentiation: an unknown
 * token, an expired one, a revoked one, a soft-deleted one, a rate-limited request, a
 * missing engagement, and a reviewer who has left the client company. Distinguishing any
 * of them would turn the page into an oracle — "this token was real once", "this person
 * still works there". `page.test.tsx` asserts the markup is identical across all of them.
 *
 * ⚠ NO "EMAIL ME A NEW LINK" CTA. That would be an unauthenticated email-send primitive
 * (an email-bomb amplifier and an existence oracle) and needs its own ticket, rate limit
 * and non-enumerating response. The recovery offered instead is signing in.
 *
 * ⚠⚠ THE CTA PROMISES ONLY WHAT EXISTS TODAY: it opens the engagement, it does NOT say
 * you can rate from there. This page is the terminal state for every expired, revoked and
 * departed-reviewer arrival, i.e. exactly the audience with no other route in; sending
 * them after a control that is not there is the one thing it must not do.
 *
 * **BAL-389 HAS NOW MOUNTED `RatingInput`, AND THE WORDING STILL MUST NOT CHANGE.** That
 * ticket mounts the capture on `/meetings/{meetingId}/end` — BEHIND AN INERT ENTRY POINT.
 * No code path navigates there: the in-call leave handler that would send a participant to
 * it is BAL-435, and no Daily SDK ships in `apps/web` today. `/engagements/[id]` — the one
 * route this CTA can realistically lead a signed-in reviewer to — still carries no rating
 * control at all. So "sign in and rate from there" would remain FALSE for every reader of
 * this card, which is the only test that matters here.
 * **Restore the rate-from-here wording when BAL-435 lands the leave handler that makes
 * `/meetings/{meetingId}/end` reachable** — and only if the route the CTA actually points
 * at can, by then, be reached with the control on it.
 *
 * ⚠ AND IT NAMES NO ENGAGEMENT KIND. `listClosedBetween` returns `[]` until BAL-420/421
 * give `close()` a caller (D4/D5), so EVERY live review link in production today is a
 * PROJECT link — "rate from the case" named the one kind that cannot yet produce one.
 * The generic noun is also what keeps this card free of any oracle: it renders
 * byte-identically for six different outcomes and must not vary by engagement.
 *
 * DRAFT COPY — pending MJ sign-off. Warm, blameless, and it points at a real next step.
 */
export function LinkNotActive(): React.JSX.Element {
  return (
    <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Link2Off className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">This link isn&apos;t active</h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        Review links stop working after a while. You can still leave your review — sign in and open
        the engagement.
      </p>
      <Link
        href="/login"
        className="bg-primary text-primary-foreground focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-[13.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        Sign in to open the engagement
      </Link>
      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </div>
  );
}
