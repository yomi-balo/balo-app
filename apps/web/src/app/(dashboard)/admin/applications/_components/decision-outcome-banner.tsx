import { CircleCheck, Lock } from 'lucide-react';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import { LocalDate } from '@/components/local-date';
import { formatDecisionAttribution } from '../_lib/application-list-view';
import { DECLINE_REASON_LABEL } from '../_lib/decline-copy';

/**
 * BAL-549 — "Approved by Dana @ Balo · 3 Sep" / "Declined by Dana @ Balo · 3 Sep — Not a fit
 * right now", plus the `decline_note` under a `Lock` glyph, labelled so nobody mistakes it for
 * applicant-visible copy. Server Component — no I/O, no interactivity.
 *
 * ⚠⚠ `declineNote` IS STAFF-ONLY. This is the ONE place on this surface it is read back — never
 * pass it anywhere applicant-facing.
 *
 * ⚠ THE DATE IS A `<LocalDate>` CHILD, NOT PART OF THE ATTRIBUTION STRING (web-review fix round,
 * W4): it renders in the VIEWER's timezone, because the previous UTC label showed Melbourne staff
 * the PREVIOUS calendar day for any decision recorded before ~10am AEST. See
 * `formatDecisionAttribution` for the full ruling.
 *
 * BAL-593 — a SECOND arm, `kind: 'approved_unrecorded'`, for an `approved` application whose
 * `decidedAt` is `null` (approved before decisions were logged, or imported from Bubble — AC 10).
 * It renders no attribution and no `<LocalDate>`: there is no decider and no timestamp to show.
 * The default arm (`kind` omitted, or `'recorded'`) keeps every existing prop and caller.
 */

interface RecordedDecisionOutcomeBannerProps {
  readonly kind?: 'recorded';
  readonly decision: 'approved' | 'declined';
  readonly decidedByFirstName: string | null;
  readonly decidedByLastName: string | null;
  readonly decidedAt: Date;
  readonly declineReason: ExpertDeclineReason | null;
  readonly declineNote: string | null;
}

interface ApprovedUnrecordedBannerProps {
  readonly kind: 'approved_unrecorded';
}

type DecisionOutcomeBannerProps =
  | RecordedDecisionOutcomeBannerProps
  | ApprovedUnrecordedBannerProps;

export function DecisionOutcomeBanner(
  props: Readonly<DecisionOutcomeBannerProps>
): React.JSX.Element {
  if (props.kind === 'approved_unrecorded') {
    return (
      <div className="border-success/30 bg-success/10 flex items-start gap-3 rounded-2xl border p-4">
        <CircleCheck className="text-success mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          {/* pending-MJ */}
          <p className="text-foreground text-sm font-semibold">Approved, no decision record</p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Approved before decisions were logged, or imported from Bubble.
          </p>
        </div>
      </div>
    );
  }

  const { decision, decidedByFirstName, decidedByLastName, decidedAt, declineReason, declineNote } =
    props;
  const attribution = formatDecisionAttribution({
    decision,
    decidedByFirstName,
    decidedByLastName,
  });
  const reasonLabel = declineReason === null ? null : DECLINE_REASON_LABEL[declineReason];

  return (
    <div
      className={
        decision === 'approved'
          ? 'border-success/30 bg-success/10 rounded-2xl border p-4'
          : 'border-border bg-muted rounded-2xl border p-4'
      }
    >
      <p className="text-foreground text-sm font-semibold">
        {attribution}
        {' · '}
        <LocalDate iso={decidedAt.toISOString()} />
        {reasonLabel !== null && <span className="text-muted-foreground"> — {reasonLabel}</span>}
      </p>
      {declineNote !== null && declineNote.length > 0 && (
        <div className="mt-3 flex items-start gap-2">
          <Lock className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              {/* pending-MJ */}
              Balo-only note — never shown to the applicant
            </p>
            <p className="text-foreground mt-0.5 text-sm leading-relaxed">{declineNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}
