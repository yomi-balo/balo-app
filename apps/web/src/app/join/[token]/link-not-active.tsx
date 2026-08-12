import { Link2Off } from 'lucide-react';
import { JOIN_UNAVAILABLE_BODY, JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

/**
 * The SINGLE generic bail-out for the guest join landing (BAL-408 / ADR-1044).
 *
 * ⚠ EVERY inactive outcome renders EXACTLY this, with no differentiation: an unknown
 * token, an EXPIRED one, a REVOKED one, a SOFT-DELETED guest row, a DENIED admission, a
 * meeting that was CANCELLED or soft-deleted, and a rate-limited request. That uniformity
 * is not tidiness — `meetingGuestsRepository.findLiveByTokenHash` returns `undefined`
 * IDENTICALLY for the first six by contract, and differentiating any of them here would
 * put the oracle back ("this token was real once", "that meeting exists but was
 * cancelled", "you were removed"). `page.test.tsx` asserts the markup is BYTE-IDENTICAL
 * across all seven.
 *
 * ⚠⚠ NO RECOVERY CTA AT ALL — and this is where this card DIVERGES from `/review`'s,
 * deliberately. The review card sends the reader to `/login`, because a reviewer is a Balo
 * user who has an account to sign into. **A GUEST HAS NO ACCOUNT.** They were invited by
 * email precisely because they are not on the platform, so "sign in" is not a degraded
 * recovery route — it is a dead end that would read as "you need an account to attend",
 * which is the opposite of what this feature promises. The real recovery is a human one:
 * ask the person who invited you. So the copy says exactly that and offers no button.
 *
 * ⚠ NO "EMAIL ME A NEW LINK". That would be an unauthenticated email-send primitive (an
 * email-bomb amplifier and an existence oracle) and needs its own ticket, rate limit and
 * non-enumerating response.
 *
 * ⚠ IT NAMES NOTHING — no meeting, no company, no agency, no date, no inviter. It renders
 * for a token that never existed, so it cannot reference anything a token might have
 * resolved to; and it must stay identical across outcomes, so it cannot vary by anything
 * at all. It takes NO PROPS for that reason — the type system is the enforcement.
 *
 * ⚠⚠ THE COPY IS **GENUINELY** SHARED WITH `/join/m/[meetingId]`'s `LobbyUnavailable`, via
 * `JOIN_UNAVAILABLE_TITLE` / `JOIN_UNAVAILABLE_BODY`. It used to be two sets of hardcoded
 * literals that the lobby's docblock merely CLAIMED could not drift — and they had already
 * drifted ("Invitation links…" here versus "Meeting links…" there). Two surfaces enforcing one
 * indistinguishability property must render one string, or the property is per-surface only.
 *
 * ⚠ WHICH IS WHY THE BODY NO LONGER SAYS "invited you": this card renders for an EMAILED guest,
 * the lobby's renders for someone who was FORWARDED a bare URL by a person nobody recorded.
 * "Whoever shared this one with you" is true for both.
 *
 * DRAFT COPY — pending MJ sign-off. Warm, blameless, gender-neutral, and it points at a
 * next step that actually exists.
 */
export function LinkNotActive(): React.JSX.Element {
  return (
    <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Link2Off className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">{JOIN_UNAVAILABLE_TITLE}</h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        {JOIN_UNAVAILABLE_BODY}
      </p>
      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </div>
  );
}
