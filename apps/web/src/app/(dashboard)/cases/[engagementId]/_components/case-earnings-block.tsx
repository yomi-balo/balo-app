'use client';

import { formatAud } from '@/components/balo/recap/money-block';
import type { CaseEarningsView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 (D2) — the EXPERT lens's own-earnings block on this case.
 *
 * ⚠⚠ "NO DATA" AND "A$0.00" MUST NEVER RENDER THE SAME. Nothing writes
 * `credit_sessions.engagement_id` yet (BAL-400 will), so EVERY case on `main` today resolves
 * to `not_yet` — and a component that formatted a number regardless would show "A$0.00", a
 * MONEY CLAIM, to every expert on the platform. The view type makes the figure structurally
 * unrepresentable outside the `finalized` arm; this component's job is simply never to invent
 * one. A `finalized` block CAN legitimately be `0` — that is a REAL zero, and it is exactly
 * why the three states must stay visibly distinct.
 *
 * ⚠⚠ FEE CONCEALMENT. This renders own EARNINGS only — the un-marked-up accrual. There is no
 * client-side equivalent anywhere on this surface (owner decision, 2026-07-31: no client-lens
 * running total), and the Balo margin appears in NEITHER lens. The `CaseSurfaceView`
 * discriminant is what makes that structural: a client-lens view has no `earnings` field, so
 * this component cannot be rendered on that arm at all.
 */
export function CaseEarningsBlock({
  earnings,
}: Readonly<{ earnings: CaseEarningsView }>): React.JSX.Element {
  return (
    <div className="border-border mt-3.5 border-t pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground text-xs">Earned on this case</span>
        {earnings.state === 'finalized' && (
          <span className="text-foreground font-mono text-sm font-semibold tabular-nums">
            {formatAud(earnings.earningsAudMinor)}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{describe(earnings)}</p>
    </div>
  );
}

/**
 * The one explanatory line, per state.
 *
 * ⚠ A `switch`, NOT NESTED TERNARIES (SonarCloud), and every arm is reachable.
 */
function describe(earnings: CaseEarningsView): string {
  switch (earnings.state) {
    case 'not_yet':
      // ⚠ NO FIGURE, NOT EVEN ZERO. This is the state the whole platform is in today.
      return 'Earnings appear here once a consultation on this case has been billed.';
    case 'pending':
      return `${earnings.pendingCount} consultation${
        earnings.pendingCount === 1 ? '' : 's'
      } still being finalised.`;
    default: {
      const from = `from ${earnings.finalizedCount} consultation${
        earnings.finalizedCount === 1 ? '' : 's'
      }`;
      return earnings.pendingCount > 0
        ? `${from} · ${earnings.pendingCount} still finalising`
        : from;
    }
  }
}
