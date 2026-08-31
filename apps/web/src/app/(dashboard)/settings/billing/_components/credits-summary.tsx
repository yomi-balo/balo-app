'use client';

import Link from 'next/link';
import { Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WalletWidget } from '@/components/balo/credit/wallet-widget';
import { MemberWalletNudge } from '@/components/billing/top-up/MemberWalletNudge';
import { resolveRestingState } from '@/lib/credit/display-constants';
import { track, SETTINGS_EVENTS, WALLET_EVENTS } from '@/lib/analytics';
import type { DashboardWalletData } from '@/lib/credit/wallet-read';

interface CreditsSummaryProps {
  readonly data: DashboardWalletData;
}

/**
 * BAL-503 — Credits & billing's client leaf. Two lenses, resolved server-side by the
 * `MANAGE_BILLING` capability check inside `loadDashboardWalletData` (never `role ===` /
 * `activeMode ===`):
 *
 * - `holder` — the vetted `WalletWidget` (its `healthy`/`low`/`zero` resting states come for
 *   free from `resolveRestingState`) plus a "Top up" link and a "Redeem a code" link. These are
 *   the ONLY two outbound links — the top-up composer is NOT duplicated or moved here (it is a
 *   full-viewport, three-branch state machine — pre-flight O1), and `/promo-codes` is struck
 *   (O5 — an admin-only minting surface that must not leak its existence).
 * - `member` — `MemberWalletNudge`, reused verbatim: team-framed copy, the "let {name} know"
 *   action, and its own Sonner toasts. No "Top up", no "Redeem a code" — `/redeem`'s Server
 *   Action refuses without `MANAGE_BILLING`, so offering it here would be a dead end.
 *
 * Analytics: this is the wallet's THIRD surface, so per the BAL-499 precedent it emits its own
 * `settings_billing_*` click events rather than sharing the dashboard card's `WALLET_EVENTS`
 * series (which would make an already-shipped signal ambiguous) or skipping them (which would make
 * Settings-originated intent invisible). The member nudge reuses the EXISTING
 * `wallet_nudge_clicked` via `MemberWalletNudge`'s own `onNudgeClick` hook — same event, same
 * shape, so no new constant is minted for a surface-agnostic action.
 */
export function CreditsSummary({ data }: Readonly<CreditsSummaryProps>): React.JSX.Element {
  if (data.kind === 'member') {
    return (
      <MemberWalletNudge
        balanceMinor={data.balanceMinor}
        adminLabel={data.adminLabel}
        fx={null}
        onNudgeClick={(state) => track(WALLET_EVENTS.NUDGE_CLICKED, { state })}
      />
    );
  }

  const state = resolveRestingState(data.balanceMinor);
  return (
    <div className="flex flex-col gap-4">
      <WalletWidget
        state={state}
        balanceMinor={data.balanceMinor}
        fx={data.fx}
        action={
          <Button asChild variant="default" className="min-h-11 w-full">
            <Link
              href="/billing/top-up"
              onClick={() =>
                track(SETTINGS_EVENTS.BILLING_TOPUP_CLICKED, { balance_minor: data.balanceMinor })
              }
            >
              Top up
            </Link>
          </Button>
        }
      />
      <p className="text-muted-foreground text-sm leading-relaxed">
        Need a one-off boost between top-ups? Redeem a promo code for extra credit.
      </p>
      <Button asChild variant="secondary" className="min-h-11 w-full gap-2 sm:w-auto">
        <Link
          href="/redeem"
          onClick={() =>
            track(SETTINGS_EVENTS.BILLING_REDEEM_CLICKED, { balance_minor: data.balanceMinor })
          }
        >
          <Ticket className="size-4" aria-hidden="true" />
          Redeem a code
        </Link>
      </Button>
    </div>
  );
}
