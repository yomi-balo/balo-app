import { Building2, CreditCard, ReceiptText } from 'lucide-react';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { getTaxIdLabel } from '@/lib/billing/tax-id-labels';
import type { AdminKickoffBillingView } from '@/lib/project-request/admin-kickoff-billing-view';
import { RequestCard } from '../request-card';
import { RemindClientButton } from './remind-client-button';

interface AdminKickoffBillingPanelProps {
  view: AdminKickoffBillingView | null;
  requestId: string;
  acceptedRelationshipId: string;
  /** The client-billing kickoff gate — drives the reminder affordance visibility. */
  clientBillingConfirmed: boolean;
}

/** Human label for a pricing method. */
const PRICING_METHOD_LABEL: Record<'fixed' | 'tm', string> = {
  fixed: 'Fixed price',
  tm: 'Time & materials',
};

/** Human label for a billing cadence. */
const CADENCE_LABEL: Record<'monthly' | 'fortnightly', string> = {
  monthly: 'Monthly',
  fortnightly: 'Fortnightly',
};

/** Compact "8h 30m" effort label from a minutes count. */
function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * The right-aligned milestone value: estimated effort for T&M, the line amount for
 * Fixed. Em dash when the relevant figure is absent.
 */
function formatMilestoneValue(
  milestone: NonNullable<AdminKickoffBillingView['terms']>['milestones'][number],
  currency: string,
  isTm: boolean
): string {
  if (isTm) {
    return milestone.estimatedMinutes === null ? '—' : formatMinutes(milestone.estimatedMinutes);
  }
  return milestone.valueCents === null ? '—' : formatWholeCurrency(milestone.valueCents, currency);
}

/**
 * BAL-324 — admin-only billing + payment-terms panel. Server-rendered, semantic
 * tokens only (light + dark aware), amounts in `font-mono tabular-nums`. Two
 * sections: the client's company billing identity, and the accepted proposal's
 * payment terms (branching Fixed → total + installments vs T&M → deposit / rate /
 * cadence + estimate). Data-driven rows — no copy-pasted branches. While the
 * client-billing gate is outstanding it invites the admin to remind the client.
 */
export function AdminKickoffBillingPanel({
  view,
  requestId,
  acceptedRelationshipId,
  clientBillingConfirmed,
}: Readonly<AdminKickoffBillingPanelProps>): React.JSX.Element {
  return (
    <RequestCard className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="bg-info/10 border-info/20 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border">
          <ReceiptText className="text-info h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <h3 className="text-foreground text-sm font-semibold">Billing &amp; payment terms</h3>
      </div>

      <BillingSection
        billing={view?.billing ?? null}
        clientBillingConfirmed={clientBillingConfirmed}
        requestId={requestId}
        acceptedRelationshipId={acceptedRelationshipId}
      />

      <div className="border-border my-5 border-t" />

      <TermsSection terms={view?.terms ?? null} />
    </RequestCard>
  );
}

interface BillingSectionProps {
  billing: NonNullable<AdminKickoffBillingView['billing']> | null;
  clientBillingConfirmed: boolean;
  requestId: string;
  acceptedRelationshipId: string;
}

/** The client's company billing identity — the four-state read surface. */
function BillingSection({
  billing,
  clientBillingConfirmed,
  requestId,
  acceptedRelationshipId,
}: Readonly<BillingSectionProps>): React.JSX.Element {
  return (
    <section aria-labelledby="admin-billing-details-heading">
      <div className="mb-3 flex items-center gap-1.5">
        <Building2 className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
        <h4
          id="admin-billing-details-heading"
          className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
        >
          Billing details
        </h4>
      </div>

      {billing === null ? (
        <BillingEmptyState
          clientBillingConfirmed={clientBillingConfirmed}
          requestId={requestId}
          acceptedRelationshipId={acceptedRelationshipId}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          <DetailRow label="Legal name" value={billing.legalName} />
          <DetailRow label="Country" value={billing.countryCode} mono />
          <DetailRow
            label={getTaxIdLabel(billing.countryCode).label}
            value={billing.taxId ?? '—'}
            mono={billing.taxId !== null}
          />
          <DetailRow label="Billing email" value={billing.billingEmail} />
          {billing.address !== null && <DetailRow label="Address" value={billing.address} />}
        </div>
      )}
    </section>
  );
}

interface BillingEmptyStateProps {
  clientBillingConfirmed: boolean;
  requestId: string;
  acceptedRelationshipId: string;
}

/**
 * Empty billing state, framed as an action (balo-ui-skill): while the gate is
 * outstanding, invite the admin to nudge the client — never a bare absence. Once
 * the gate is confirmed (billing settled another way), show a settled note with no
 * reminder affordance.
 */
function BillingEmptyState({
  clientBillingConfirmed,
  requestId,
  acceptedRelationshipId,
}: Readonly<BillingEmptyStateProps>): React.JSX.Element {
  if (clientBillingConfirmed) {
    return (
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        Billing gate confirmed — no company billing record is on file.
      </p>
    );
  }

  return (
    <div className="border-border bg-muted/30 flex flex-col gap-3 rounded-xl border border-dashed p-4">
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        The client hasn&apos;t added their company billing details yet — kickoff is blocked until
        they do. Send them a reminder to move this forward.
      </p>
      <RemindClientButton requestId={requestId} relationshipId={acceptedRelationshipId} />
    </div>
  );
}

interface TermsSectionProps {
  terms: NonNullable<AdminKickoffBillingView['terms']> | null;
}

/** The accepted proposal's payment terms — Fixed vs T&M shapes. */
function TermsSection({ terms }: Readonly<TermsSectionProps>): React.JSX.Element {
  return (
    <section aria-labelledby="admin-payment-terms-heading">
      <div className="mb-3 flex items-center gap-1.5">
        <CreditCard className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
        <h4
          id="admin-payment-terms-heading"
          className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
        >
          Payment terms
        </h4>
      </div>

      {terms === null ? (
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          No accepted proposal on this relationship yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <DetailRow label="Pricing method" value={PRICING_METHOD_LABEL[terms.pricingMethod]} />
          {terms.pricingMethod === 'tm' ? (
            <TimeAndMaterialsTerms terms={terms} />
          ) : (
            <FixedTerms terms={terms} />
          )}
          <MilestonesList terms={terms} />
        </div>
      )}
    </section>
  );
}

type TermsProps = Readonly<{ terms: NonNullable<AdminKickoffBillingView['terms']> }>;

/** A labelled group of line-item rows (Installments / Milestones). */
function LineItemGroup({
  heading,
  children,
}: Readonly<{ heading: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        {heading}
      </p>
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </div>
  );
}

/** A single line-item row: truncating title on the left, value node on the right. */
function LineItemRow({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <li className="border-border bg-card flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <span className="text-foreground min-w-0 truncate text-[12.5px]" title={title}>
        {title}
      </span>
      {children}
    </li>
  );
}

/** T&M terms: non-binding estimate + deposit / rate / cadence. */
function TimeAndMaterialsTerms({ terms }: TermsProps): React.JSX.Element {
  return (
    <>
      <DetailRow
        label="Estimate"
        value={formatWholeCurrency(terms.priceCents, terms.currency)}
        mono
      />
      {terms.rateCents !== null && (
        <DetailRow label="Rate" value={formatWholeCurrency(terms.rateCents, terms.currency)} mono />
      )}
      {terms.depositCents !== null && (
        <DetailRow
          label="Deposit"
          value={formatWholeCurrency(terms.depositCents, terms.currency)}
          mono
        />
      )}
      {terms.cadence !== null && (
        <DetailRow label="Billing cadence" value={CADENCE_LABEL[terms.cadence]} />
      )}
      <p className="text-muted-foreground text-[11.5px] leading-relaxed italic">
        Time &amp; materials — the estimate is non-binding; final billing follows actual effort.
      </p>
    </>
  );
}

/** Fixed terms: committed total + % installment schedule (derived amounts). */
function FixedTerms({ terms }: TermsProps): React.JSX.Element {
  return (
    <>
      <DetailRow label="Total" value={formatWholeCurrency(terms.priceCents, terms.currency)} mono />
      {terms.installments.length > 0 && (
        <LineItemGroup heading="Installments">
          {terms.installments.map((inst) => (
            <LineItemRow key={inst.id} title={inst.label}>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-muted-foreground text-[12.5px] tabular-nums">
                  ({inst.pct}%)
                </span>
                <span className="text-foreground font-mono text-[12.5px] tabular-nums">
                  {formatWholeCurrency(inst.amountCents, terms.currency)}
                </span>
              </span>
            </LineItemRow>
          ))}
        </LineItemGroup>
      )}
    </>
  );
}

/** Milestone list — Fixed shows line value, T&M shows estimated effort. */
function MilestonesList({ terms }: TermsProps): React.JSX.Element | null {
  if (terms.milestones.length === 0) return null;
  const isTm = terms.pricingMethod === 'tm';

  return (
    <LineItemGroup heading="Milestones">
      {terms.milestones.map((m) => (
        <LineItemRow key={m.id} title={m.title}>
          <span className="text-muted-foreground shrink-0 font-mono text-[12.5px] tabular-nums">
            {formatMilestoneValue(m, terms.currency, isTm)}
          </span>
        </LineItemRow>
      ))}
    </LineItemGroup>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  /** Render the value in `font-mono tabular-nums` (ids, codes, amounts). */
  mono?: boolean;
}

/** A single label → value row. */
function DetailRow({ label, value, mono = false }: Readonly<DetailRowProps>): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0 text-[12.5px]">{label}</span>
      <span
        className={
          mono
            ? 'text-foreground min-w-0 text-right font-mono text-[12.5px] break-words tabular-nums'
            : 'text-foreground min-w-0 text-right text-[12.5px] break-words'
        }
      >
        {value}
      </span>
    </div>
  );
}
