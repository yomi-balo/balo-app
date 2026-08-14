import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The ONE accessible name for a displayed rating aggregate, and the ONE inline treatment
 * that renders it (BAL-422 fix round).
 *
 * ⚠⚠ WHY THIS EXISTS AT ALL. BAL-422 mounted the aggregate on six surfaces, each of which
 * hand-rolled the same three nodes: an `aria-hidden` star, a bare `4.8`, and a bare `(12)`.
 * A screen reader announced that as **"4.8 12"** — two orphan numbers with no unit, no
 * scale and no denominator label, on every one of them. Nothing in that markup says
 * "rating", says "out of 5", or says what the parenthesised number counts.
 *
 * ⚠⚠ AND THE COUNT MEANS **ENGAGEMENTS**, NOT REVIEWS. `expert_profiles.rating_count`
 * counts ENGAGEMENTS REVIEWED — a five-person company reviewing one engagement contributes
 * 1, not 5 (one engagement, one vote). So the accessible name says "engagements". Writing
 * "12 reviews" here would state a number the product does not have, to the audience least
 * able to check it against the visual. That is the whole reason this string lives in ONE
 * place: it is the sentence most likely to be quietly re-worded wrong on a copy of itself.
 *
 * ⚠ THE VISUAL NODES ARE `aria-hidden`, THE NAME IS `sr-only`. Not both: leaving the digits
 * exposed would make a screen reader read the value twice, once as a sentence and once as
 * loose numerals. `getByText('4.8')` still finds the visual node — `aria-hidden` does not
 * remove an element from the accessibility TREE for `getByText`, and the `sr-only` sentence
 * is a different, non-exact string — so existing text assertions are unaffected.
 *
 * ⚠ NULL IS NOT THIS COMPONENT'S JOB. Every caller null-gates on the AVERAGE before
 * rendering (`ratingAverage !== null`), because "no reviews" is a different surface
 * treatment on each of them — omit the stat, omit the badge, omit the fragment. Accepting
 * `number | null` here would centralise a decision that is genuinely per-surface, and would
 * put a `0.0` one careless `?? 0` away from being renderable.
 */
export function ratingAccessibleName(average: number, count: number): string {
  const noun = count === 1 ? 'engagement' : 'engagements';
  return `Rated ${average.toFixed(1)} out of 5 across ${count} ${noun}`;
}

/**
 * The `sr-only` sentence on its own — for surfaces whose VISUAL layout is not the inline
 * star/number/count row and therefore cannot use {@link InlineRating}. The profile hero's
 * stats strip is the one such caller: its value and unit ride generic slots shared with
 * Experience and Certs, and its visible "Rating" label sits in a separate `<p>` with no
 * programmatic association to the number.
 */
export function RatingAccessibleName({
  average,
  count,
}: Readonly<{ average: number; count: number }>): React.JSX.Element {
  return <span className="sr-only">{ratingAccessibleName(average, count)}</span>;
}

export interface InlineRatingProps {
  /** The average, 1..5. Callers null-gate BEFORE rendering — see the docblock above. */
  average: number;
  /** ENGAGEMENTS REVIEWED, not review rows. */
  count: number;
  /**
   * Star box classes. Each surface keeps its own scale (the proposal summary card runs
   * `h-2.5`, everything else `h-3`); the colour is fixed and not overridable.
   */
  starClassName?: string;
  /** Classes on the average itself — `expert-card`'s float chip bolds it, nothing else does. */
  valueClassName?: string;
  /** Classes on the `(n)` denominator. */
  countClassName?: string;
}

/**
 * `★ 4.8 (12)` — a FRAGMENT, deliberately. It emits no wrapper, so each caller keeps its
 * own `inline-flex`, gap, text size and separator logic; only the three nodes and the
 * accessible name are shared.
 *
 * ⚠ THE COUNT IS NEVER DIMMED BELOW `text-muted-foreground`. It shipped as
 * `text-muted-foreground/60` at 11–12px — roughly 2.4:1 in light mode, under the 4.5:1
 * WCAG AA floor — which rendered the DENOMINATOR as the faintest thing on the row while the
 * average sat at full weight. That is precisely the "5.0 (1)" ≈ "5.0 (50)" misreading the
 * count was added to prevent. `countClassName` exists for size and spacing; do not use it
 * to re-introduce an opacity.
 */
export function InlineRating({
  average,
  count,
  starClassName,
  valueClassName,
  countClassName,
}: Readonly<InlineRatingProps>): React.JSX.Element {
  return (
    <>
      <RatingAccessibleName average={average} count={count} />
      <Star className={cn('text-warning h-3 w-3 fill-current', starClassName)} aria-hidden="true" />
      <span aria-hidden="true" className={valueClassName}>
        {average.toFixed(1)}
      </span>
      <span aria-hidden="true" className={cn('text-muted-foreground', countClassName)}>
        ({count})
      </span>
    </>
  );
}
