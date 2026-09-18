import { cn } from '@/lib/utils';
import { caseTrailAriaLabel } from '../_lib/cases-index-presentation';
import type { CaseTrailEntry, CaseTrailMark } from '../_lib/cases-index-view-types';

/**
 * BAL-567 — a case's consultation trail: one mark per consultation, oldest first, on a hairline
 * that reads as the case's timeline.
 *
 * ⚠⚠ THE MARKS ARE `aria-hidden` AND THE WHOLE ROW CARRIES ONE `role="img"` + `aria-label`.
 * Individually they are meaningless shapes; announced one at a time they would be five pieces of
 * noise. The label — "Consultations: 2 held, 1 booked" — is the entire information, and it is
 * built by `caseTrailAriaLabel` so the index and any future surface word it identically.
 *
 * ⚠ THE KEY IS THE CONSULTATION'S ORDINAL, NEVER THE ARRAY INDEX (SonarCloud S6479 flags an
 * interpolated index too). See `CaseTrailEntry` for why the ordinal is carried.
 *
 * PURE PRESENTATIONAL: no state, no effects, no directive of its own — it renders inside the
 * card islands and inherits their boundary.
 */

/**
 * ⚠ SHAPE CARRIES THE MEANING, NOT COLOUR ALONE (WCAG 1.4.1). Held is a filled disc, booked is an
 * outlined ring, cancelled is a dashed ring, and the two "did not happen" marks are flat greys —
 * so the trail is still readable in greyscale and to a colour-blind reader. The `aria-label`
 * above is the belt to this pair of braces.
 */
const MARK_CLASS: Readonly<Record<CaseTrailMark, string>> = {
  held: 'bg-primary',
  booked: 'border-primary bg-card border-2',
  cancelled: 'border-muted-foreground bg-card border border-dashed',
  missed: 'bg-muted-foreground/60',
  unrecorded: 'bg-border',
};

export function CaseTrail({
  trail,
}: Readonly<{ trail: readonly CaseTrailEntry[] }>): React.JSX.Element | null {
  const label = caseTrailAriaLabel(trail);
  if (label === null) return null;

  return (
    <span role="img" aria-label={label} className="relative inline-flex items-center gap-1.5">
      {/* The hairline behind the marks. Inset by half a mark so it never pokes out at either end. */}
      <span
        aria-hidden="true"
        className="bg-border absolute top-1/2 right-1 left-1 h-px -translate-y-1/2"
      />
      {trail.map((entry) => (
        <span
          key={entry.ordinal}
          aria-hidden="true"
          className={cn(
            'relative box-border size-[9px] shrink-0 rounded-full',
            MARK_CLASS[entry.mark]
          )}
        />
      ))}
    </span>
  );
}
