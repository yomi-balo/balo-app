'use client';

import { useEffect } from 'react';
import { Loader2, Receipt, ArrowUpRight } from 'lucide-react';
import type { SessionMoneyBlock } from '@balo/shared/credit';
import { track, CASE_BILLING_EVENTS } from '@/lib/analytics';

/**
 * BAL-399 — the recap MONEY-BLOCK fragment (ADR-1043 layer split). Presentational; renders the
 * fee-concealed `ClientMoneyBlock | ExpertMoneyBlock` the api resolved per lens. BAL-388 owns the
 * recap PAGE that embeds this fragment (the money-line, design refs `post-meeting-recap.jsx` Meta +
 * `end-of-call.jsx`). All four balo-ui states: loading (skeleton), error (muted fallback — never a
 * raw error / internals), pending (elapsed-only affordance), success (finalized figure). Currency
 * is `font-mono tabular-nums`; dark mode via semantic tokens only.
 */

/** Re-exported from `@balo/shared/credit` (declared ONCE there) for co-located fragment usage. */
export type { SessionMoneyBlock };

interface MoneyBlockProps {
  /** The resolved block, or `null` when the fetch failed (→ the muted fallback). */
  block: SessionMoneyBlock | null;
  /** `true` while the block is being fetched (→ the skeleton pill). */
  loading?: boolean;
  /** Elapsed session minutes, shown in the PENDING state (from the recap page's timing). */
  elapsedMinutes?: number;
}

/** AUD minor units → `A$150.00` (thousands-grouped, two fraction digits). */
function formatAud(minor: number): string {
  return `A$${(minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Lens-derived copy so the render stays branch-free (no nested ternaries). */
const LENS_COPY = {
  client: { Icon: Receipt, pendingLabel: 'Charge pending', linkLabel: 'receipt' },
  expert: { Icon: ArrowUpRight, pendingLabel: 'Payout pending', linkLabel: 'payout' },
} as const;

/** The own-side finalized amount for the lens (client all-in vs expert earnings). */
function finalizedAmountMinor(block: SessionMoneyBlock): number {
  return block.lens === 'client' ? block.amountAudMinor : block.earningsAudMinor;
}

/** Skeleton pill (loading). */
function MoneyBlockSkeleton() {
  return (
    <span
      className="bg-muted inline-flex h-6 w-32 animate-pulse rounded-md"
      aria-label="Loading receipt"
    />
  );
}

/** Muted fallback (error) — never leaks internals. */
function MoneyBlockUnavailable() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
      <Receipt size={14} aria-hidden="true" /> Receipt will be ready shortly
    </span>
  );
}

/** Pending affordance — elapsed only + a spinning "Charge/Payout pending" pill. */
function MoneyBlockPending({
  block,
  elapsedMinutes,
}: Readonly<{ block: SessionMoneyBlock; elapsedMinutes: number }>) {
  const { Icon, pendingLabel } = LENS_COPY[block.lens];
  useEffect(() => {
    track(CASE_BILLING_EVENTS.PENDING_SHOWN, {
      session_id: block.sessionId,
      elapsed_min: elapsedMinutes,
    });
    // Fire once on mount of the pending fragment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
      <Icon size={14} aria-hidden="true" />
      {/* <output> carries an implicit role="status" + aria-live="polite" so the pending → finalized
          transition is announced to assistive tech (SonarCloud S6819). */}
      <output className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
        <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{' '}
        {pendingLabel}
      </output>
      {elapsedMinutes > 0 && (
        <span className="text-muted-foreground">{elapsedMinutes} min elapsed</span>
      )}
    </span>
  );
}

/** Finalized — the own-side figure + a receipt/payout link. */
function MoneyBlockFinalized({ block }: Readonly<{ block: SessionMoneyBlock }>) {
  const { Icon, linkLabel } = LENS_COPY[block.lens];
  return (
    <span className="text-foreground inline-flex items-center gap-1.5 text-sm">
      <Icon size={14} className="text-muted-foreground" aria-hidden="true" />
      <span className="font-mono tabular-nums">{formatAud(finalizedAmountMinor(block))}</span>
      <a
        href={`/sessions/${block.sessionId}/${linkLabel}`}
        aria-label={`View ${linkLabel}`}
        className="text-primary focus-visible:ring-ring text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        {linkLabel}
      </a>
    </span>
  );
}

/** The recap money block — dispatches to the right state. */
export function MoneyBlock({
  block,
  loading = false,
  elapsedMinutes = 0,
}: Readonly<MoneyBlockProps>) {
  if (loading) {
    return <MoneyBlockSkeleton />;
  }
  if (block === null) {
    return <MoneyBlockUnavailable />;
  }
  if (block.state === 'pending') {
    return <MoneyBlockPending block={block} elapsedMinutes={elapsedMinutes} />;
  }
  return <MoneyBlockFinalized block={block} />;
}

export { formatAud };
