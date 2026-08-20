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

/**
 * Lens-derived copy so the render stays branch-free (no nested ternaries).
 *
 * ⚠⚠ `finalizedLabel` IS WHAT MAKES THE FIGURE MEAN SOMETHING. Suppressing the
 * receipt/payout ANCHOR (BAL-388, D-C — no `/sessions/:id/receipt` or `/sessions/:id/payout`
 * route exists) also removed the only TEXT attached to the number: the meta line rendered an
 * `aria-hidden` icon and a bare `A$150.00`, so a screen reader announced the single most
 * consequential fact on the recap with no context at all, and a sighted expert had no clue the
 * figure was earnings. D-C required dropping the LINK, not the MEANING — so the label is now
 * rendered as muted text beside the amount. The anchor stays suppressed.
 */
const LENS_COPY = {
  client: { Icon: Receipt, pendingLabel: 'Charge pending', finalizedLabel: 'Charged' },
  expert: { Icon: ArrowUpRight, pendingLabel: 'Payout pending', finalizedLabel: 'Your payout' },
} as const;

/** The own-side finalized amount for the lens (client all-in vs expert earnings). */
function finalizedAmountMinor(block: SessionMoneyBlock): number {
  return block.lens === 'client' ? block.amountAudMinor : block.earningsAudMinor;
}

/**
 * BAL-412 (D13, plan §7.3) — the finalized duration line. `money-block.tsx` never read
 * `block.durationMinutes` before this ticket; the finalized branch had no duration slot at all.
 * Keyed on `settlementShape` FIRST (the two zero shapes have no number to attach — there is
 * nothing to floor when nobody was charged) and on `billingFloorApplied` second. `no_show_client`
 * is checked ahead of `billingFloorApplied` because that shape is arithmetically NOT floored
 * (the expert already held >= the floor) yet still wants the "billed at the minimum" framing —
 * see the plan's note that keys it on shape rather than the flag.
 *
 * Quiet fact, never punitive, never scolding, gender-neutral, no absence framing — the same
 * register as the booking-flow billing line.
 *
 * ⚠ MJ COPY CHECKPOINT — all six strings below are pending MJ sign-off (flagged in the PR body).
 * ⚠ D12.3 — this stays INSIDE `money-block.tsx`, not a shared helper: extracting it would trip
 * `apps/web/src/invariants/no-money-block-in-call.test.ts`, which scans for the substring
 * `recap/money-block` across the live-call render tree.
 */
function durationLine(block: SessionMoneyBlock): string {
  if (block.settlementShape === 'missed_call') {
    return block.lens === 'client'
      ? "Not charged — your consultant didn't join this time" // pending-MJ
      : "No earnings recorded — the call didn't take place"; // pending-MJ
  }
  if (block.settlementShape === 'abandoned_wait') {
    // F12(b), UX review round 1 — `actualMinutes` (the real connected time before the
    // session was abandoned) is deliberately NOT surfaced here: "Not charged"/"No earnings
    // recorded" plus a partial-minute figure reads as more detail than an abandoned session
    // warrants. Revisit if MJ copy sign-off disagrees.
    return block.lens === 'client' ? 'Not charged' : 'No earnings recorded'; // pending-MJ
  }
  if (block.settlementShape === 'no_show_client') {
    // F9, UX review round 1 — `actualMinutes`, not `durationMinutes`: `durationMinutes` is the
    // BILLED (post-floor) figure, which for this shape is the SAME number as the floor itself
    // and would state it twice while discarding the real time the expert held the room.
    return block.lens === 'client'
      ? `${block.actualMinutes} min held · billed at the ${block.billingFloorMinutes}-minute minimum` // pending-MJ
      : `${block.actualMinutes} min held · paid the ${block.billingFloorMinutes}-minute minimum`; // pending-MJ
  }
  if (block.billingFloorApplied) {
    return block.lens === 'client'
      ? `${block.actualMinutes} min · billed at the ${block.billingFloorMinutes}-minute minimum` // pending-MJ
      : `${block.actualMinutes} min · paid the ${block.billingFloorMinutes}-minute minimum`; // pending-MJ
  }
  return `${block.durationMinutes} min`; // pending-MJ
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

/**
 * Finalized — the own-side figure, as PLAIN TEXT.
 *
 * ⚠ NO RECEIPT/PAYOUT ANCHOR (BAL-388, D-C). See {@link LENS_COPY}: the `/sessions/:id/receipt`
 * and `/sessions/:id/payout` routes do not exist, so the anchor was a link to nowhere. The
 * FIGURE — the thing a client or expert actually came for — is unchanged.
 */
function MoneyBlockFinalized({ block }: Readonly<{ block: SessionMoneyBlock }>) {
  const { Icon, finalizedLabel } = LENS_COPY[block.lens];
  return (
    // F10, UX review round 1 — `flex-wrap` (was a rigid single-row `inline-flex`) so the
    // BAL-412 duration line can drop onto its own row instead of overflowing/clipping at
    // narrow widths; the outer `whitespace-nowrap` that used to force this onto one line was
    // removed from `RecapHeader`'s `MoneyLine` for the same reason.
    <span className="text-foreground inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      <Icon size={14} className="text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">{finalizedLabel}</span>
      <span className="font-mono tabular-nums">{formatAud(finalizedAmountMinor(block))}</span>
      <span className="text-muted-foreground">{durationLine(block)}</span>
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
