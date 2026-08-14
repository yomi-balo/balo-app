import { MessageCircle, Star } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { SectionLabel } from '@/components/expert/profile';

/**
 * "Reviews" — AGGREGATE-AWARE (BAL-422), in two states.
 *
 * ⚠⚠ THIS SECTION HAD TO MOVE WHEN THE HERO DID. Wiring the hero rating stat alone would ship
 * a visible contradiction: the hero asserting "4.8 (12)" directly above a section saying "No
 * reviews yet". The two now read from the same aggregate and cannot disagree.
 *
 * ⚠ RATED → state the AGGREGATE ONLY. NO review BODIES, NO per-review stars, and
 * `reviewsRepository.listPublicByExpert` STAYS UNMOUNTED — review bodies are explicitly out of
 * BAL-422's scope and no ticket owns mounting them. The single accent star is the canonical
 * `RatingBadge` treatment, not a fabricated five-star row (`RatingStars` / `StarRow` remain
 * deliberately unmounted).
 *
 * ⚠⚠ AND THE COPY MUST NOT PROMISE THEM EITHER. This section used to close with "Written
 * reviews will appear here as clients share them." — a commitment to a surface NOBODY OWNS.
 * `listPublicByExpert` has no caller and no ticket to give it one, while BAL-390 is capturing
 * review bodies TODAY, so the sentence would age from optimistic to false without anyone
 * touching this file. The closing line now explains the number that IS on screen (where it
 * comes from, and why the denominator counts engagements rather than people). If a ticket
 * ever does mount bodies, THAT ticket writes the promise.
 *
 * ⚠ THE COUNT SAYS "ENGAGEMENTS", NOT "REVIEWS", AND THAT IS LOAD-BEARING. `ratingCount`
 * counts ENGAGEMENTS REVIEWED, not review rows — a 5-person company reviewing one engagement
 * contributes 1. Writing "12 reviews" would misstate what the number is.
 *
 * ⚠ UNRATED → an INVITATION, never absence framing (CLAUDE.md), and never hidden: a visitor
 * CAN act from here. BAL-422 DID change the heading — it was "No reviews yet", which is
 * exactly the framing that rule forbids — but it must not simply restate the line beneath it,
 * so the heading states where ratings come from and the sub-line does the inviting. (An
 * earlier draft of this docblock claimed the empty state was unchanged. It was not.)
 */
export function ReviewsSection({
  firstName,
  ratingAverage,
  ratingCount,
}: Readonly<{
  firstName: string;
  /** `null` ⇒ NO REVIEWS. Never 0.0 — the scale starts at 1. */
  ratingAverage: number | null;
  ratingCount: number;
}>): React.JSX.Element {
  return (
    <Card className="gap-0 p-7">
      <SectionLabel icon={MessageCircle} tone="muted" className="mb-4">
        Reviews
      </SectionLabel>
      {ratingAverage === null ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="bg-muted mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
            <MessageCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
          </div>
          <p className="text-foreground text-sm font-semibold">Ratings come from completed work</p>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
            Be the first to work with {firstName} and share how it went.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="bg-warning/10 mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
            <Star className="text-warning h-6 w-6 fill-current" aria-hidden="true" />
          </div>
          <p className="text-foreground text-2xl font-semibold tabular-nums">
            {ratingAverage.toFixed(1)}
          </p>
          <p className="text-muted-foreground mt-1 text-sm font-medium">
            average across {ratingCount} {ratingCount === 1 ? 'engagement' : 'engagements'}
          </p>
          <p className="text-muted-foreground mt-3 max-w-sm text-sm leading-relaxed">
            Every rating comes from a client who completed work with {firstName} on Balo. Each
            engagement counts once, however many people on the client&apos;s team rated it.
          </p>
        </div>
      )}
    </Card>
  );
}
