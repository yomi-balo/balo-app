'use client';

import { AlertTriangle, CheckCircle2, ChevronRight, ShieldCheck } from 'lucide-react';
import { sumEstimatedMinutes } from '@balo/shared/pricing';
import { cn } from '@/lib/utils';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { PayoutAssuranceNote } from './payout-assurance-note';
import { pricingMethodLabel } from './proposal-summary-cells';
import type {
  ProposalDraftState,
  ReadinessIssue,
  ReadinessResult,
} from './proposal-composer-state';

interface ProposalSummaryCardProps {
  state: ProposalDraftState;
  totalCents: number;
  readiness: ReadinessResult;
  /** Non-blocking suggestions shown once the proposal is ready (e.g. an unaddressed change note). */
  softIssues: ReadinessIssue[];
  /** Whether the expert attached their own terms document. */
  termsAttached: boolean;
  /** Revise mode relabels the CTA to "Preview and resend". */
  reviseMode: boolean;
  /** Bumped by the composer to replay the checklist nudge when the CTA is hit with issues left. */
  nudgeKey: number;
  onJump: (issue: ReadinessIssue) => void;
  onPreview: () => void;
}

/** The headline "You receive" figure and its supporting line, shared with the mobile bar. */
export interface RailTotal {
  /** The formatted amount, or "—" when there is nothing to show yet. */
  amount: string;
  /** Trailing unit shown beside the amount (T&M only). */
  unit: string | null;
  sub: string;
}

/** "1 thing" / "2 things". */
export function pluralise(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The expert's own figure at identity — never the client-facing (marked-up) price. */
export function railTotal(state: ProposalDraftState, totalCents: number): RailTotal {
  if (state.pricingMethod === 'fixed') {
    const count = state.installments.length;
    return {
      amount: totalCents > 0 ? formatWholeCurrency(totalCents, state.currency) : '—',
      unit: null,
      sub:
        totalCents > 0
          ? `Paid in ${count} ${pluralise(count, 'payment', 'payments')}`
          : 'Set your project price',
    };
  }
  const minutes = sumEstimatedMinutes(state.milestones);
  const hours = Math.round(minutes / 60);
  return {
    amount: state.rateCents === null ? '—' : formatWholeCurrency(state.rateCents, state.currency),
    unit: state.rateCents === null ? null : '/hr',
    sub:
      minutes > 0
        ? `About ${hours} ${pluralise(hours, 'hour', 'hours')}, estimated ${formatWholeCurrency(totalCents, state.currency)}`
        : 'Add hour estimates to see an estimate',
  };
}

/** The CTA label shared by the rail and the mobile bar. */
export function previewCtaLabel(reviseMode: boolean): string {
  return reviseMode ? 'Preview and resend' : 'Preview and send';
}

function paymentsSummary(state: ProposalDraftState): string {
  if (state.pricingMethod === 'tm') {
    return `${state.cadence === 'monthly' ? 'Monthly' : 'Fortnightly'} invoices`;
  }
  if (state.installments.length === 0) return 'Not set';
  return state.installments.map((i) => `${i.pct}%`).join(' / ');
}

function timeframeSummary(weeks: number | null): string {
  if (weeks === null) return 'Not set';
  return `About ${weeks} ${pluralise(weeks, 'week', 'weeks')}`;
}

interface IssueButtonProps {
  issue: ReadinessIssue;
  soft?: boolean;
  onJump: (issue: ReadinessIssue) => void;
}

function IssueButton({
  issue,
  soft = false,
  onJump,
}: Readonly<IssueButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onJump(issue)}
      className={cn(
        'focus-visible:ring-ring -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none',
        soft ? 'text-muted-foreground hover:bg-muted' : 'text-foreground/80 hover:bg-warning/10'
      )}
    >
      <span>{issue.label}</span>
      <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

/**
 * The composer's right-hand rail (BAL-610): what the expert receives, a property
 * summary, the jump-to checklist, and a "Preview and send" CTA. The CTA is never
 * disabled — with issues left it is the composer's cue to jump to the first one —
 * and nothing is sent from here: the full-page preview owns the commit. Money is the
 * expert's own quote; no client-facing (marked-up) figure is ever shown.
 */
export function ProposalSummaryCard({
  state,
  totalCents,
  readiness,
  softIssues,
  termsAttached,
  reviseMode,
  nudgeKey,
  onJump,
  onPreview,
}: Readonly<ProposalSummaryCardProps>): React.JSX.Element {
  const isFixed = state.pricingMethod === 'fixed';
  const total = railTotal(state, totalCents);
  const issueCount = readiness.issues.length;

  const rows: { label: string; value: string }[] = [
    { label: 'Pricing', value: pricingMethodLabel(state.pricingMethod) },
    { label: 'Milestones', value: String(state.milestones.length) },
    { label: 'Timeframe', value: timeframeSummary(state.timeframeWeeks) },
    { label: isFixed ? 'Payments' : 'Billing', value: paymentsSummary(state) },
    { label: 'Terms', value: termsAttached ? 'Balo and yours' : 'Balo standard' },
  ];

  return (
    <div className="border-border bg-card rounded-2xl border p-5">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        You receive
      </h2>
      <p className="text-foreground mt-1 text-[28px] leading-tight font-semibold tracking-tight tabular-nums">
        {total.amount}
        {total.unit !== null && (
          <small className="text-muted-foreground ml-0.5 text-base font-medium">{total.unit}</small>
        )}
      </p>
      <p className="text-muted-foreground mt-0.5 text-[13px]">{total.sub}</p>

      <span className="border-success/30 bg-success/10 text-success-strong mt-2.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold">
        <ShieldCheck className="h-2.5 w-2.5" aria-hidden="true" />
        100% yours
      </span>

      <PayoutAssuranceNote pricingMethod={state.pricingMethod} />

      <dl className="border-border mt-4 space-y-2.5 border-t pt-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-[13px]">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-foreground text-right font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div
        key={nudgeKey}
        className={cn(
          'border-border mt-4 border-t pt-4',
          nudgeKey > 0 && 'animate-shake motion-reduce:animate-none'
        )}
      >
        {issueCount > 0 ? (
          <>
            <p className="text-warning-strong mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {issueCount} {pluralise(issueCount, 'thing', 'things')} left before you can send
            </p>
            {readiness.issues.map((issue) => (
              <IssueButton key={`${issue.id}:${issue.targetId}`} issue={issue} onJump={onJump} />
            ))}
          </>
        ) : (
          <>
            <p className="text-success-strong mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              Ready to send
            </p>
            {softIssues.map((issue) => (
              <IssueButton
                key={`${issue.id}:${issue.targetId}`}
                issue={issue}
                soft
                onJump={onJump}
              />
            ))}
          </>
        )}
      </div>

      <button
        type="button"
        onClick={onPreview}
        className={cn(
          'focus-visible:ring-ring mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
          PROPOSAL_CTA_GRADIENT_CLASS
        )}
      >
        {previewCtaLabel(reviseMode)}
      </button>
      <p className="text-muted-foreground mt-3 text-center text-[12px]">
        Nothing is sent until you confirm in the preview.
      </p>
    </div>
  );
}
