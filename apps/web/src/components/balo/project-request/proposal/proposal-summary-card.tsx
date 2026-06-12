'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { ProposalDraftState, ReadinessResult } from './proposal-composer-state';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ProposalSummaryCardProps {
  state: ProposalDraftState;
  totalCents: number;
  readiness: ReadinessResult;
  /** First name of the client this proposal goes to. */
  clientFirstName: string;
  termsDocumentCount: number;
  saveStatus: SaveStatus;
  /** Disabled while a submit is in flight. */
  submitting: boolean;
  onSubmit: () => void;
  /** Revise mode (A6.4 / BAL-290) — relabel Submit to "Resubmit as v{n}". */
  reviseMode?: boolean;
  /** The version this resubmit will write (revise mode only) — defaults to 2. */
  nextVersion?: number;
}

interface SummaryRow {
  label: string;
  value: string;
}

const SAVE_LABEL: Record<SaveStatus, string | null> = {
  idle: null,
  saving: 'Saving…',
  saved: 'Saved as draft',
  error: "Couldn't save draft",
};

/**
 * "Proposal at a glance" — the live summary + readiness panel + Submit. Reused as
 * the desktop sticky card AND inside the mobile bottom-sheet. Submit is disabled
 * until `readiness.ready`; clicking it opens the confirm dialog (owned by parent).
 */
export function ProposalSummaryCard({
  state,
  totalCents,
  readiness,
  clientFirstName,
  termsDocumentCount,
  saveStatus,
  submitting,
  onSubmit,
  reviseMode = false,
  nextVersion = 2,
}: Readonly<ProposalSummaryCardProps>): React.JSX.Element {
  const isFixed = state.pricingMethod === 'fixed';
  const submitLabel = reviseMode ? `Resubmit as v${nextVersion}` : `Submit to ${clientFirstName}`;

  const rows: SummaryRow[] = [
    { label: 'Pricing', value: isFixed ? 'Fixed price' : 'Time & materials' },
    {
      label: isFixed ? 'Total' : 'Estimate',
      value: formatWholeCurrency(totalCents, state.currency),
    },
    { label: 'Milestones', value: String(state.milestones.length) },
    {
      label: 'Timeframe',
      value: state.timeframeWeeks === null ? '—' : `~${state.timeframeWeeks} weeks`,
    },
    {
      label: 'Terms',
      value: termsDocumentCount > 0 ? 'Standard + supplement' : 'Balo standard',
    },
  ];

  const saveLabel = SAVE_LABEL[saveStatus];

  return (
    <div className="border-border bg-card rounded-2xl border p-5">
      <h2 className="text-foreground text-sm font-semibold">Proposal at a glance</h2>

      <dl className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-[13px]">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-foreground font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div
        className={cn(
          'mt-4 rounded-[12px] border p-3',
          readiness.ready ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'
        )}
      >
        {readiness.ready ? (
          <p className="text-success flex items-center gap-2 text-[13px] font-semibold">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Ready to submit
          </p>
        ) : (
          <div>
            <p className="text-warning flex items-center gap-2 text-[13px] font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              Before you can submit
            </p>
            <ul className="text-foreground/80 mt-2 space-y-1 text-[12px]">
              {readiness.issues.map((issue) => (
                <li key={issue} className="flex gap-1.5">
                  <span className="bg-warning mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!readiness.ready || submitting}
        className={cn(
          'focus-visible:ring-ring mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          PROPOSAL_CTA_GRADIENT_CLASS
        )}
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {submitLabel}
      </button>

      {saveLabel !== null && (
        <p
          className={cn(
            'mt-3 flex items-center justify-center gap-1.5 text-[12px]',
            saveStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-live="polite"
        >
          {saveStatus === 'saving' && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          )}
          {saveLabel}
        </p>
      )}
    </div>
  );
}
