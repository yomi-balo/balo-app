'use client';

import { useEffect, useRef, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { formatAud } from '@/lib/credit/display-constants';
import type { AdminSessionMoneyResult } from '@/lib/api/admin-session-money-block';
import { fetchLookupMoneyBlockAction } from '../_actions/fetch-lookup-money-block';

/**
 * BAL-551 — the drill-in's Money section, credit sessions only. Fetch-on-select via the
 * `fetchLookupMoneyBlockAction` Server Action, ALL-OR-NOTHING (B5): there is no `canSeeFees`
 * prop, no per-row lock line, and no fee-less projection. The D5 bundle split is where a
 * fee-blind staff viewer becomes reachable — not this ticket.
 *
 * A single labelled SECTION, not a tab bar (with the Timeline tab cut, one tab would remain,
 * and a one-tab tab bar is a defect).
 */

interface LookupMoneySectionProps {
  readonly sessionId: string;
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
    <output
      aria-busy="true"
      className="border-warning/30 bg-warning/5 block rounded-xl border p-3.5"
    >
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

function ReasonNotice({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return <p className="text-muted-foreground text-xs">{text}</p>;
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

  if (state === 'loading') return <LoadingSkeleton />;

  if (!state.ok) {
    return (
      <div className="border-warning/30 bg-warning/5 rounded-xl border p-3.5">
        <ReasonNotice text={REASON_COPY[state.reason]} />
        {state.reason === 'unavailable' && (
          <button
            type="button"
            onClick={() => setRetryToken((token) => token + 1)}
            className="text-warning focus-visible:ring-ring mt-2 inline-flex min-h-[44px] items-center rounded px-1 text-xs font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const { block } = state;
  const isPending = block.state === 'pending';

  return (
    <div className="border-warning/30 bg-warning/5 rounded-xl border p-3.5">
      <div className="mb-2 flex items-center gap-1.5">
        <DollarSign className="text-warning size-3" aria-hidden="true" />
        <span className="text-warning text-[11px] font-bold tracking-wide uppercase">Money</span>
        <span className="text-muted-foreground text-[11px]">
          · from the rate snapshots on the row
        </span>
      </div>
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
