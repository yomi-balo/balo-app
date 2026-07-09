'use client';

import { Clock, Hourglass } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { ProposalDoc } from './proposal-doc';
import { PayoutAssuranceNote } from './payout-assurance-note';
import { BackChannel } from './back-channel';
import type { AdminProposalPricing, ProposalReviewDoc } from './proposal-review-types';

interface SubmittedViewProps {
  /** Whose waiting framing to show — the submitting expert, or an observing admin. */
  lens: 'expert' | 'admin';
  doc: ProposalReviewDoc;
  /** The client (display name) reviewing the proposal. */
  clientName: string;
  /** Other live proposals on this request besides `doc` (drives "alongside N others"). */
  otherProposalCount: number;
}

interface WaitingCopy {
  icon: LucideIcon;
  headline: string;
  sub: string;
}

/** Build the lens-specific waiting banner copy. */
function waitingCopy(props: Readonly<SubmittedViewProps>): WaitingCopy {
  const { lens, clientName, otherProposalCount } = props;
  if (lens === 'expert') {
    const plural = otherProposalCount > 1 ? 's' : '';
    const alongside =
      otherProposalCount > 0 ? ` alongside ${otherProposalCount} other${plural}` : '';
    return {
      icon: Hourglass,
      headline: `Proposal sent to ${clientName}`,
      sub: `They're reviewing it${alongside}. You'll be notified the moment they respond.`,
    };
  }
  return {
    icon: Clock,
    headline: `${otherProposalCount + 1} proposals submitted — client reviewing`,
    sub: 'No action until the client accepts one or asks for changes.',
  };
}

/** Format a basis-point fee rate as a whole/partial percent, e.g. 2500 → "25%". */
function formatFeePercent(bps: number): string {
  return `${bps / 100}%`;
}

interface AdminPricingRow {
  label: string;
  value: string;
  emphasis?: 'margin' | 'client';
}

/** Build the admin breakdown rows — expert quote, Balo fee %, client price, margin,
 *  plus the both-sides deposit/rate lines when the proposal carries them (T&M). */
function adminPricingRows(pricing: AdminProposalPricing, currency: string): AdminPricingRow[] {
  const rows: AdminPricingRow[] = [
    {
      label: 'Expert quote (payout)',
      value: formatWholeCurrency(pricing.expertPriceCents, currency),
    },
    { label: 'Balo fee', value: formatFeePercent(pricing.baloFeeBps) },
    {
      label: 'Client price (charged)',
      value: formatWholeCurrency(pricing.clientPriceCents, currency),
      emphasis: 'client',
    },
    {
      label: 'Balo margin',
      value: formatWholeCurrency(pricing.marginCents, currency),
      emphasis: 'margin',
    },
  ];
  if (pricing.clientDepositCents !== null) {
    rows.push({
      label: 'Deposit (expert → client)',
      value: `${formatWholeCurrency(pricing.expertDepositCents ?? 0, currency)} → ${formatWholeCurrency(
        pricing.clientDepositCents,
        currency
      )}`,
    });
  }
  if (pricing.clientRateCents !== null) {
    rows.push({
      label: 'Rate/hr (expert → client)',
      value: `${formatWholeCurrency(pricing.expertRateCents ?? 0, currency)} → ${formatWholeCurrency(
        pricing.clientRateCents,
        currency
      )}`,
    });
  }
  return rows;
}

/** Color class for an admin pricing row value, keyed by emphasis. Extracted from a
 *  nested ternary (SonarJS no-nested-conditional) — output is byte-identical. */
function pricingValueClassName(emphasis: AdminPricingRow['emphasis']): string {
  const base = 'text-right font-semibold tabular-nums';
  if (emphasis === 'margin') return `text-success ${base}`;
  if (emphasis === 'client') return `text-primary ${base}`;
  return `text-foreground ${base}`;
}

/**
 * Admin-only pricing breakdown (BAL-357). Renders the fee/margin decomposition that
 * is structurally absent from the shared {@link ProposalDoc} body — the raw expert
 * quote (payout basis), the Balo fee %, the client-charged price, and the derived
 * margin. Admin lens only; never reaches expert or client surfaces.
 */
function AdminPricingCard({
  pricing,
  currency,
}: Readonly<{ pricing: AdminProposalPricing; currency: string }>): React.JSX.Element {
  const rows = adminPricingRows(pricing, currency);
  return (
    <div className="border-primary/20 bg-primary/[0.04] rounded-2xl border p-5 sm:p-6">
      <p className="text-foreground text-sm font-semibold">Pricing breakdown</p>
      <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
        Admin only — the expert sees their quote; the client sees the marked-up price.
      </p>
      <dl className="mt-4 flex flex-col gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 text-[13.5px]">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className={pricingValueClassName(row.emphasis)}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The read-only "submitted, awaiting the client" surface (A6.4 / BAL-289) for the
 * expert and admin lenses. A waiting banner (warning tone) frames the wait, then
 * the same {@link ProposalDoc} renders read-only (no `sectionIdPrefix` → no
 * anchors, no scroll-spy). The expert lens gets a demoted back-channel to nudge
 * the client; the admin lens does not (admins don't message on the expert's behalf).
 * The admin lens also gets the {@link AdminPricingCard} fee/margin breakdown (the
 * only surface where the Balo fee is exposed — BAL-357).
 */
export function SubmittedView(props: Readonly<SubmittedViewProps>): React.JSX.Element {
  const { lens, doc, clientName } = props;
  const { icon: Icon, headline, sub } = waitingCopy(props);

  return (
    <div className="flex flex-col gap-4">
      <div className="border-warning/30 bg-warning/10 flex items-start gap-3 rounded-2xl border p-4">
        <span className="bg-warning/15 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
          <Icon className="text-warning h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">{headline}</p>
          <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">{sub}</p>
        </div>
      </div>

      <div className="border-border bg-card rounded-2xl border p-5 sm:p-6">
        <ProposalDoc doc={doc} />
        {lens === 'expert' && <PayoutAssuranceNote pricingMethod={doc.pricingMethod} />}
      </div>

      {lens === 'admin' && doc.adminPricing && (
        <AdminPricingCard pricing={doc.adminPricing} currency={doc.currency} />
      )}

      {lens === 'expert' && (
        <div className="flex justify-start px-0.5">
          <BackChannel name={clientName} />
        </div>
      )}
    </div>
  );
}
