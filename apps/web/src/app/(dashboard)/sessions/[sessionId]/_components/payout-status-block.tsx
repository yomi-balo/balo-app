import { AlertCircle, CheckCircle2, Clock, ArrowUpRight, type LucideIcon } from 'lucide-react';
import type { MoneyBlockPayoutStatus } from '@balo/shared/credit';
import type { ExpertPayoutReference } from '@balo/shared/credit';
import { formatLongUtc } from '@/lib/format/utc-date';
import {
  STATEMENT_SHARED_COPY,
  PAYOUT_STATUS_COPY,
  PAYOUT_STATUS_LABELS,
} from '../_lib/statement-copy';

interface StatusMeta {
  label: string;
  Icon: LucideIcon;
  tint: string;
}

/**
 * ⚠ Only `recorded` is ever WRITTEN today (`enums.ts:535`; the rest await the BAL-202/203
 * Airwallex payout run) — the four states are rendered because the enum HAS them, but no copy
 * here may imply a disbursement is already in progress.
 */
const STATUS_META: Readonly<Record<MoneyBlockPayoutStatus, StatusMeta>> = {
  recorded: {
    label: PAYOUT_STATUS_LABELS.recorded,
    Icon: Clock,
    tint: 'text-muted-foreground bg-muted',
  },
  disbursing: {
    label: PAYOUT_STATUS_LABELS.disbursing,
    Icon: ArrowUpRight,
    tint: 'text-info bg-info/10',
  },
  paid: {
    label: PAYOUT_STATUS_LABELS.paid,
    Icon: CheckCircle2,
    tint: 'text-success bg-success/10',
  },
  // Amber (warning), never destructive-red — this is never the expert's fault.
  failed: {
    label: PAYOUT_STATUS_LABELS.failed,
    Icon: AlertCircle,
    tint: 'text-warning bg-warning/10',
  },
};

/**
 * EXPERT-lens only. `payoutStatus` absent (the real gap between billing finalization and the
 * payout-record write) renders NO status block at all — never a fourth, undefined badge state.
 * `Recorded` / `Reference` render only once the obligation is booked (`payout !== null`).
 */
export function PayoutStatusBlock({
  payoutStatus,
  payout,
}: Readonly<{
  payoutStatus?: MoneyBlockPayoutStatus;
  payout: ExpertPayoutReference | null;
}>): React.JSX.Element | null {
  if (payoutStatus === undefined) {
    return null;
  }
  const meta = STATUS_META[payoutStatus];
  const body = PAYOUT_STATUS_COPY[payoutStatus];

  return (
    <div className="border-border mt-6 rounded-lg border p-4">
      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{STATEMENT_SHARED_COPY.payoutStatusRowLabel}</dt>
          <dd>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.tint}`}
            >
              <meta.Icon size={12} aria-hidden="true" />
              {meta.label}
            </span>
          </dd>
        </div>
        {payout !== null && (
          <>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">
                {STATEMENT_SHARED_COPY.payoutRecordedRowLabel}
              </dt>
              <dd className="text-foreground">{formatLongUtc(new Date(payout.recordedAtIso))}</dd>
            </div>
            {/*
              ⚠ NO `truncate` HERE — IT WOULD UNDO OWNER RULING Q2 IN CSS. Q2 chose the verbatim
              UUID over a `PYT-` prefix or a slice precisely so the reference is a key support can
              look up and an expert can quote. `truncate` (overflow-hidden + ellipsis + nowrap)
              renders a 36-char mono UUID as `aaaaaaaa-bbbb-cc…` at 375px: the value stays intact
              in the DOM and `select-all` still copies it, but a reader cannot READ it off a
              phone, which was the whole point. Stack on mobile and wrap instead of clipping.
            */}
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <dt className="text-muted-foreground shrink-0">
                {STATEMENT_SHARED_COPY.payoutReferenceRowLabel}
              </dt>
              <dd className="text-foreground font-mono text-xs break-all select-all sm:text-right">
                {payout.reference}
              </dd>
            </div>
          </>
        )}
      </dl>
      {body !== undefined && <p className="text-muted-foreground mt-3 text-xs">{body}</p>}
    </div>
  );
}
