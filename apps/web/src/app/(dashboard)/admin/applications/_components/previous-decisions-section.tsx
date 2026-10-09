import { Lock } from 'lucide-react';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import { LocalDate } from '@/components/local-date';
import { formatDecisionAttribution } from '../_lib/application-list-view';
import { DECLINE_REASON_LABEL } from '../_lib/decline-copy';

/**
 * BAL-557 — the staff review page's "previous decisions" section: every archived decision
 * for this application (today, always a decline — see `expert_application_decisions`), newest
 * first, so a reopened-and-resubmitted application keeps its history discoverable.
 *
 * Server Component — no I/O, no interactivity. Rendered under the review workspace on
 * `[profileId]/page.tsx`, fed by `expertApplicationDecisionsRepository.listForStaffReview`.
 *
 * ⚠⚠ `declineNote` IS STAFF-ONLY. The page passes it ONLY when the viewer holds
 * `REVIEW_EXPERT_APPLICATIONS` (the same rule as `DecisionOutcomeBanner`'s current-decision
 * note) — this component itself does no gating, so a caller that passes the note unconditionally
 * would leak it. It never crosses a `'use client'` boundary.
 *
 * ⚠ HIDDEN WHEN THERE ARE NO ROWS (CLAUDE.md empty-state exception) — this is purely
 * retrospective data a staff viewer cannot act on or populate from here.
 */

export interface PreviousDecisionRowView {
  readonly id: string;
  readonly decidedByFirstName: string | null;
  readonly decidedByLastName: string | null;
  readonly decidedAt: Date | null;
  readonly declineReason: ExpertDeclineReason | null;
  /** `null` unless the viewer holds `REVIEW_EXPERT_APPLICATIONS` (page-level gate). */
  readonly declineNote: string | null;
  readonly submittedAt: Date | null;
}

interface PreviousDecisionsSectionProps {
  readonly decisions: readonly PreviousDecisionRowView[];
}

export function PreviousDecisionsSection({
  decisions,
}: Readonly<PreviousDecisionsSectionProps>): React.JSX.Element | null {
  if (decisions.length === 0) return null;

  return (
    <section className="space-y-3">
      {/* pending-MJ */}
      <h3 className="text-foreground text-sm font-semibold">Previous decisions</h3>
      <div className="space-y-3">
        {decisions.map((decision) => {
          const attribution = formatDecisionAttribution({
            decision: 'declined',
            decidedByFirstName: decision.decidedByFirstName,
            decidedByLastName: decision.decidedByLastName,
          });
          const reasonLabel =
            decision.declineReason === null ? null : DECLINE_REASON_LABEL[decision.declineReason];

          return (
            <div key={decision.id} className="border-border bg-muted rounded-2xl border p-4">
              <p className="text-foreground text-sm font-semibold">
                {attribution}
                {decision.decidedAt !== null && (
                  <>
                    {' · '}
                    <LocalDate iso={decision.decidedAt.toISOString()} />
                  </>
                )}
                {reasonLabel !== null && (
                  <span className="text-muted-foreground"> — {reasonLabel}</span>
                )}
              </p>
              {decision.submittedAt !== null && (
                <p className="text-muted-foreground mt-0.5 text-sm">
                  {/* pending-MJ */}
                  Submitted <LocalDate iso={decision.submittedAt.toISOString()} />
                </p>
              )}
              {decision.declineNote !== null && decision.declineNote.length > 0 && (
                <div className="mt-3 flex items-start gap-2">
                  <Lock
                    className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
                      {/* pending-MJ */}
                      Balo-only note — never shown to the applicant
                    </p>
                    <p className="text-foreground mt-0.5 text-sm leading-relaxed">
                      {decision.declineNote}
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
