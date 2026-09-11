'use client';

import { useEffect, useRef, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { formatAud } from '@/lib/credit/display-constants';
import type { AdminSessionMoneyResult } from '@/lib/api/admin-session-money-block';
import { fetchLookupMoneyBlockAction } from '../_actions/fetch-lookup-money-block';
import { LookupSectionRetryNotice } from './lookup-section-retry-notice';

/**
 * BAL-551 — the drill-in's Money section, credit sessions only. Fetch-on-select via the
 * `fetchLookupMoneyBlockAction` Server Action, ALL-OR-NOTHING (B5): there is no `canSeeFees`
 * prop, no per-row lock line, and no fee-less projection. The D5 bundle split is where a
 * fee-blind staff viewer becomes reachable — not this ticket.
 *
 * Rendered as a TAB when the drill-in has two (credit sessions), and never alone: a one-tab
 * tab bar is still a defect, so every other type renders its Timeline as a labelled SECTION
 * with no tab bar at all (BAL-555 C2).
 *
 * BAL-555 fix round F10 — `labelled` mirrors `LookupTimelineSection`'s prop of the same name:
 * `false` (the drill-in's only call site today, since credit sessions are the only two-tab
 * type) suppresses the box treatment and the "Money" eyebrow, so switching tabs doesn't visibly
 * jump between a boxed card (Money) and bare content (Timeline). The prop exists — rather than
 * hard-deleting the box — so the two sections' state machines read identically and either could
 * ship as a standalone labelled SECTION again without a second implementation.
 */

interface LookupMoneySectionProps {
  readonly sessionId: string;
  readonly labelled: boolean;
}

function MoneyRow({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <>
      <span className="text-muted-foreground text-[12.5px]">{label}</span>
      <span className="text-foreground text-right font-mono text-[12.5px] font-semibold tabular-nums">
        {value}
      </span>
    </>
  );
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading money details…</span>
      <div className="space-y-2">
        <div className="bg-muted h-3.5 w-16 animate-pulse rounded" />
        <div className="bg-muted h-3.5 w-full animate-pulse rounded" />
        <div className="bg-muted h-3.5 w-full animate-pulse rounded" />
        <div className="bg-muted h-3.5 w-2/3 animate-pulse rounded" />
      </div>
    </output>
  );
}

const REASON_COPY: Record<'forbidden' | 'not_found' | 'unavailable', string> = {
  // pending-MJ
  forbidden: "Money details need fee visibility, which this account doesn't have.",
  // pending-MJ
  not_found: "This session's money record isn't available.",
  // pending-MJ
  unavailable: "These details didn't load. Nothing was changed — retry below.",
};

export function LookupMoneySection({
  sessionId,
  labelled,
}: Readonly<LookupMoneySectionProps>): React.JSX.Element {
  const [state, setState] = useState<AdminSessionMoneyResult | 'loading'>('loading');
  const requestIdRef = useRef(0);
  // BAL-551 fix round R2 — the effect below is keyed on `sessionId` alone, so re-selecting
  // the SAME row never re-runs it: the old copy's "try selecting the session again" could
  // never actually cause a refetch. `retryToken` is a second, independent dependency the
  // Retry button bumps, so a retry works without discarding the whole drill-in (the
  // reviewer's `key={opened?.seq}` remount) just to recover this one section.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState('loading');

    fetchLookupMoneyBlockAction(sessionId)
      .then((result) => {
        if (requestIdRef.current === requestId) setState(result);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setState({ ok: false, reason: 'unavailable' });
        }
      });
  }, [sessionId, retryToken]);

  const containerClassName = labelled
    ? 'border-warning/30 bg-warning/5 rounded-xl border p-3.5'
    : '';

  if (state === 'loading') {
    return (
      <div className={containerClassName}>
        <LoadingSkeleton />
      </div>
    );
  }

  if (!state.ok) {
    return (
      <LookupSectionRetryNotice
        containerClassName={containerClassName}
        message={REASON_COPY[state.reason]}
        showRetry={state.reason === 'unavailable'}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  const { block } = state;
  const isPending = block.state === 'pending';

  const eyebrow = labelled ? (
    <div className="mb-2 flex items-center gap-1.5">
      <DollarSign className="text-warning size-3" aria-hidden="true" />
      <span className="text-warning text-[11px] font-bold tracking-wide uppercase">Money</span>
      <span className="text-muted-foreground text-[11px]">
        · from the rate snapshots on the row
      </span>
    </div>
  ) : null;

  return (
    <div className={containerClassName}>
      {eyebrow}
      {isPending ? (
        <p className="text-muted-foreground text-xs">Not settled yet</p>
      ) : (
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
          <MoneyRow label="Client all-in" value={formatAud(block.clientChargeAudMinor)} />
          <MoneyRow label="Expert earnings" value={formatAud(block.expertEarningsAudMinor)} />
          <MoneyRow
            label="Balo margin"
            value={`${formatAud(block.marginAudMinor)} (${block.baloFeeBps / 100}% markup)`}
          />
          {/* BAL-551 fix round R3 — the BAL-412 billing-floor facts (`AdminMoneyBlock`) were
              already fetched and on the wire, unused. When the 15-minute minimum is what set
              the charge, say so plainly rather than showing a bare minute count that looks
              like the real duration. `settlementShape` is deliberately NOT rendered here — a
              raw enum (`no_show_client`, `abandoned_wait`, …) does not read plainly to a
              support person, and the floor sentence already says what they need. */}
          <MoneyRow
            label="Charged minutes"
            value={
              block.billingFloorApplied
                ? `${block.durationMinutes} min (actual ${block.actualMinutes} min — billed at the ${block.billingFloorMinutes}-minute minimum)`
                : `${block.durationMinutes} min`
            }
          />
          {block.overdraftSettledMinor !== 0 && (
            <MoneyRow label="Overdraft settled" value={formatAud(block.overdraftSettledMinor)} />
          )}
        </div>
      )}
    </div>
  );
}
