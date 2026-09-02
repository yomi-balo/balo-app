'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Loader2, Receipt, ArrowUpRight } from 'lucide-react';
import type { SessionMoneyBlock } from '@balo/shared/credit';
import { durationLine, finalizedAmountMinor } from '@balo/shared/credit';
import { track, CASE_BILLING_EVENTS } from '@/lib/analytics';
import { formatAud } from '@/lib/credit/display-constants';

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

/**
 * Lens-derived copy so the render stays branch-free (no nested ternaries).
 *
 * ⚠⚠ `finalizedLabel` IS WHAT MAKES THE FIGURE MEAN SOMETHING. Suppressing the
 * receipt/payout ANCHOR (BAL-388, D-C — no `/sessions/:id/receipt` or `/sessions/:id/payout`
 * route existed) also removed the only TEXT attached to the number: the meta line rendered an
 * `aria-hidden` icon and a bare `A$150.00`, so a screen reader announced the single most
 * consequential fact on the recap with no context at all, and a sighted expert had no clue the
 * figure was earnings. D-C required dropping the LINK, not the MEANING — so the label is now
 * rendered as muted text beside the amount. BAL-441 restores the link (see
 * {@link MoneyBlockFinalized}); the label stays exactly where BAL-388 put it.
 */
const LENS_COPY = {
  client: { Icon: Receipt, pendingLabel: 'Charge pending', finalizedLabel: 'Charged' },
  expert: { Icon: ArrowUpRight, pendingLabel: 'Payout pending', finalizedLabel: 'Your payout' },
} as const;

/** Skeleton pill (loading). */
function MoneyBlockSkeleton() {
  return (
    <span
      className="bg-muted inline-flex h-6 w-32 animate-pulse rounded-md"
      aria-label="Loading receipt"
    />
  );
}

/**
 * Muted fallback (error) — never leaks internals.
 *
 * ⚠ LENS-NEUTRAL COPY, DELIBERATELY. `block` is `null` here so the lens is unknown, and the
 * BAL-388 recap is the first surface that shows this fragment to an EXPERT, who has no receipt.
 */
function MoneyBlockUnavailable() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
      <Receipt size={14} aria-hidden="true" /> These details will be ready shortly
    </span>
  );
}

/** Pending affordance — elapsed only + a spinning 'Charge/Payout pending' pill. */
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

/** `/sessions/{id}/receipt|payout?from=money_block` — the ONE producer of the `money_block` source. */
function statementHref(block: SessionMoneyBlock): string {
  const segment = block.lens === 'client' ? 'receipt' : 'payout';
  return `/sessions/${block.sessionId}/${segment}?from=money_block`;
}

/**
 * Finalized — the own-side figure.
 *
 * ⚠⚠ BAL-441 RESTORES THE RECEIPT/PAYOUT ANCHOR BAL-388 SUPPRESSED (D-C — the routes now
 * exist). The label survives, OUTSIDE the link, exactly where BAL-388 put it: a sighted user
 * reads "Charged, A$150.00" with the label as plain context; a screen reader announces
 * "Charged, link, A$150.00" — the label precedes the link in the DOM, so it is read as context
 * immediately before the link's own accessible name, with no `aria-label` override that would
 * duplicate the string in a second place it could drift. THE AMOUNT ITSELF IS THE LINK — no
 * third word is appended, so the flagged "Charged A$150.00 receipt" reading cannot occur.
 *
 * ⚠⚠ D-A — THE TWO ZERO-MONEY SHAPES (`missed_call` / `abandoned_wait`) RENDER THE STATEMENT
 * ONLY, NO LABEL, NO AMOUNT, NO ANCHOR. Shipped before this ticket, `missed_call` rendered
 * "[icon] Charged A$0.00 Not charged — your consultant didn't join this time": the label and
 * the amount flatly contradicted the sentence beside them, and no test caught it because none
 * asserted the amount on those fixtures. There is also nothing to link to — the receipt/payout
 * page for these shapes has no money region to land on (plan §7.4, §9 state 8/9).
 */
function MoneyBlockFinalized({ block }: Readonly<{ block: SessionMoneyBlock }>) {
  const { Icon, finalizedLabel } = LENS_COPY[block.lens];
  const line = durationLine(block);

  if (block.settlementShape === 'missed_call' || block.settlementShape === 'abandoned_wait') {
    return (
      <span className="text-muted-foreground inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <Icon size={14} aria-hidden="true" />
        <span>{line}</span>
      </span>
    );
  }

  return (
    // F10, UX review round 1 — `flex-wrap` (was a rigid single-row `inline-flex`) so the
    // BAL-412 duration line can drop onto its own row instead of overflowing/clipping at
    // narrow widths; the outer `whitespace-nowrap` that used to force this onto one line was
    // removed from `RecapHeader`'s `MoneyLine` for the same reason.
    <span className="text-foreground inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      <Icon size={14} className="text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">{finalizedLabel}</span>
      <Link
        href={statementHref(block)}
        className="decoration-muted-foreground/40 hover:decoration-foreground focus-visible:ring-ring rounded-sm font-mono tabular-nums underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {formatAud(finalizedAmountMinor(block))}
      </Link>
      <span className="text-muted-foreground">{line}</span>
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

// `formatAud` re-exported unchanged so `cases/[engagementId]/_components/case-earnings-block.tsx`
// (and any other existing importer of this module's `formatAud`) is untouched — BAL-441 repoints
// the IMPLEMENTATION to `@/lib/credit/display-constants` (one fewer byte-identical copy of three)
// without moving the export itself.
export { formatAud };
