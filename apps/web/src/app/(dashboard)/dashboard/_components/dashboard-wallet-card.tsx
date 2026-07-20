'use client';

import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { WalletWidget } from '@/components/balo/credit/wallet-widget';
import { MemberWalletNudge } from '@/components/billing/top-up/MemberWalletNudge';
import { track, WALLET_EVENTS } from '@/lib/analytics';
import { resolveRestingState } from '@/lib/credit/display-constants';
import type { DashboardWalletData } from '@/lib/credit/wallet-read';

/** The card's data: the resolved server read, or an `error` sentinel from a failed slot read. */
export type DashboardWalletCardData = DashboardWalletData | { kind: 'error' };

/**
 * The holder Top-up affordance's className per resting state. All three build on the Button's
 * `default` variant and share a ≥44px tap target (`min-h-11`, matching the widget's error Retry)
 * plus full width. `low`/`zero` keep the solid primary CTA (the `default` variant's own
 * `bg-primary`); `healthy` — the calm, funded state — is quieted to a primary-TINTED treatment so
 * the resting card still carries a primary accent instead of reading as a neutral gray. The tint
 * (`bg-primary/10` + `text-primary` + `border-primary/20`) mirrors the vetted "In consultation"
 * pill and stays legible in both light and dark mode. Never a gradient — that is reserved for the
 * widget's `session` state (tailwind-merge resolves the tint over the variant's solid bg).
 */
function topUpButtonClassName(state: 'healthy' | 'low' | 'zero'): string {
  const base = 'min-h-11 w-full';
  if (state === 'healthy') {
    return `${base} border border-primary/20 bg-primary/10 text-primary hover:bg-primary/15`;
  }
  return base;
}

interface DashboardWalletCardProps {
  readonly data: DashboardWalletCardData;
}

/**
 * BAL-402 — the thin CLIENT leaf of the dashboard wallet card. It owns the only three
 * interactive concerns a Server Component can't: the once-on-mount `wallet_widget_viewed`
 * event, the holder Top-up click event, and the member nudge click event. It composes the
 * already-`'use client'` leaf primitives (`WalletWidget`, `MemberWalletNudge`) from the
 * projected, serialisable union — no capability check, wallet read, or FX read reaches here.
 */
export function DashboardWalletCard({
  data,
}: Readonly<DashboardWalletCardProps>): React.JSX.Element {
  const router = useRouter();
  const viewedFired = useRef(false);

  // The lens ('holder' | 'member' | null) and resting state are meaningful only for a resolved
  // read — the `error` sentinel emits no `viewed` event (no meaningful lens/state).
  const lens = data.kind === 'error' ? null : data.kind;
  const restingState = data.kind === 'error' ? null : resolveRestingState(data.balanceMinor);

  useEffect(() => {
    if (viewedFired.current) return;
    if (lens === null || restingState === null) return;
    viewedFired.current = true;
    track(WALLET_EVENTS.WIDGET_VIEWED, { lens, state: restingState });
  }, [lens, restingState]);

  const handleTopUpClick = useCallback((): void => {
    if (restingState === null) return;
    track(WALLET_EVENTS.TOPUP_CLICKED, { state: restingState });
  }, [restingState]);

  const handleNudgeClick = useCallback((state: 'low' | 'zero'): void => {
    track(WALLET_EVENTS.NUDGE_CLICKED, { state });
  }, []);

  const handleRetry = useCallback((): void => {
    router.refresh();
  }, [router]);

  if (data.kind === 'error') {
    return <WalletWidget state="error" onRetry={handleRetry} />;
  }

  if (data.kind === 'member') {
    return (
      <MemberWalletNudge
        balanceMinor={data.balanceMinor}
        adminLabel={data.adminLabel}
        fx={null}
        onNudgeClick={handleNudgeClick}
      />
    );
  }

  const holderState = resolveRestingState(data.balanceMinor);
  return (
    <WalletWidget
      state={holderState}
      balanceMinor={data.balanceMinor}
      fx={data.fx}
      action={
        <Button asChild variant="default" className={topUpButtonClassName(holderState)}>
          <Link href="/billing/top-up" onClick={handleTopUpClick}>
            Top up
          </Link>
        </Button>
      }
    />
  );
}
