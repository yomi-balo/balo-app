'use client';

import { Check, RotateCcw, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { BackChannel } from './back-channel';
import { firstName } from './proposal-name';
import type { ProposalReviewDoc } from './proposal-review-types';

interface ReviewSummaryCardProps {
  doc: ProposalReviewDoc;
  /** Opens the accept-confirm modal (owned by the parent). */
  onAccept: () => void;
  /** Opens the request-changes modal (owned by the parent). */
  onRequestChanges: () => void;
}

interface SummaryRow {
  label: string;
  value: string;
}

/** Payment summary line: installment percents (Fixed) or deposit + cadence (T&M). */
function paymentSummary(doc: ProposalReviewDoc): string {
  if (doc.pricingMethod === 'tm') {
    return doc.cadence === null ? 'Deposit' : `Deposit + ${doc.cadence}`;
  }
  if (doc.installments.length === 0) return '—';
  return doc.installments.map((installment) => `${installment.pct}%`).join(' / ');
}

/**
 * The sticky decision card on the desktop client-review surface (A6.4 / BAL-289).
 * At-a-glance summary rows + the two decision actions + a demoted back-channel.
 * Decision actions render only while `status === 'submitted'`; an already-accepted
 * doc shows an "Accepted" confirmation instead. "Request changes" opens the
 * {@link ChangesModal} (A6.4/BAL-290) via the parent-owned `onRequestChanges`.
 */
export function ReviewSummaryCard({
  doc,
  onAccept,
  onRequestChanges,
}: Readonly<ReviewSummaryCardProps>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';
  const expertFirst = firstName(doc.expert.name);

  const rows: SummaryRow[] = [
    { label: 'Pricing', value: isTM ? 'Time & Materials' : 'Fixed price' },
    {
      label: isTM ? 'Estimate' : 'Total',
      value: formatWholeCurrency(doc.priceCents, doc.currency) + (isTM ? ' est.' : ''),
    },
    { label: 'Milestones', value: String(doc.milestones.length) },
    {
      label: 'Timeframe',
      value: doc.timeframeWeeks === null ? '—' : `~${doc.timeframeWeeks} weeks`,
    },
    { label: 'Payment', value: paymentSummary(doc) },
  ];

  const isSubmitted = doc.status === 'submitted';
  const isAccepted = doc.status === 'accepted';

  return (
    <div className="border-border bg-card sticky top-[76px] rounded-2xl border p-5">
      {/* At-a-glance identity */}
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="bg-primary/10 text-primary flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl text-[13px] font-semibold">
          {doc.expert.initials}
        </span>
        <div className="min-w-0">
          <p className="text-foreground truncate text-[13.5px] font-semibold">
            {expertFirst}&apos;s proposal{doc.version > 1 ? ` · v${doc.version}` : ''}
          </p>
          {(doc.expert.rating !== null || doc.expert.company !== null) && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11.5px]">
              {doc.expert.rating !== null && (
                <>
                  <Star className="text-warning h-2.5 w-2.5 fill-current" aria-hidden="true" />
                  {doc.expert.rating}
                </>
              )}
              {doc.expert.rating !== null && doc.expert.company !== null && ' · '}
              {doc.expert.company}
            </span>
          )}
        </div>
      </div>

      {/* Summary rows */}
      <dl className="mb-4 flex flex-col gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-[13px]">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-foreground text-right font-semibold tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      {/* Decision actions — only while live & submitted */}
      {isSubmitted && (
        <>
          <button
            type="button"
            onClick={onAccept}
            className={cn(
              'focus-visible:ring-ring mb-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Accept this proposal
          </button>
          <button
            type="button"
            onClick={onRequestChanges}
            className="border-warning/30 bg-warning/10 text-warning focus-visible:ring-ring hover:bg-warning/15 mb-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Request changes
          </button>
        </>
      )}

      {isAccepted && (
        <div className="border-success/30 bg-success/10 text-success mb-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border px-4 text-sm font-semibold">
          <Check className="h-4 w-4" aria-hidden="true" />
          Accepted
        </div>
      )}

      <div className="flex justify-center">
        <BackChannel name={expertFirst} />
      </div>
    </div>
  );
}
