'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { track, WALLET_EVENTS } from '@/lib/analytics';
import { formatAud, resolveRestingState } from '@/lib/credit/display-constants';

const CHIP_CLASSNAME =
  'hidden h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none sm:inline-flex';

/**
 * BAL-499 F4 — the fallback's OUTER box matches the real chip's frame exactly (`h-8`, `gap-1.5`,
 * `rounded-lg`, `border-border`, `bg-card`, `px-2.5`), so only the inner placeholders (not the
 * chip's height/padding/border) are ever what visibly resolves. The real chip has no fixed
 * width — it sizes to icon + balance digits + (holder only) "Top up" — so a bare `w-28` box with
 * no relationship to that content caused a visible jump on resolve. Sizing the two inner bars to
 * a typical holder balance ("A$1,234.56") + "Top up" removes the worst of that jump; a small
 * residual delta remains for short/long balances and is accepted as deliberate — the fallback
 * cannot know `balanceMinor` before the server read resolves.
 */
const SKELETON_CLASSNAME =
  'hidden h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 sm:inline-flex';
const SKELETON_BAR_CLASSNAME = 'animate-pulse rounded-full bg-muted motion-reduce:animate-none';

export interface CreditsChipProps {
  readonly balanceMinor: number;
  /** MANAGE_BILLING holder ⇒ the chip carries the inline "Top up" affordance. */
  readonly canTopUp: boolean;
}

/**
 * BAL-499 — the top-bar credits chip. ONE click target (D6): the balance and the inline "Top
 * up" affordance live inside a SINGLE `<Link>` — never a nested anchor. `canTopUp` reuses
 * BAL-402's shipped `MANAGE_BILLING` audience rule (D8): a non-billing member sees the SAME
 * balance, just without the "Top up" word — never a narrower money-visibility policy invented
 * for this nav ticket. Display only — no toast, this is a navigation, not a mutation.
 */
export function CreditsChip({
  balanceMinor,
  canTopUp,
}: Readonly<CreditsChipProps>): React.JSX.Element {
  const state = resolveRestingState(balanceMinor);
  const lens = canTopUp ? 'holder' : 'member';
  const balanceLabel = formatAud(balanceMinor);
  const ariaLabel = canTopUp
    ? `Credits: ${balanceLabel} — top up`
    : `Credits: ${balanceLabel} — view credits`;

  const handleClick = useCallback((): void => {
    track(WALLET_EVENTS.CHIP_CLICKED, { lens, state });
  }, [lens, state]);

  return (
    <Link
      href="/billing/top-up"
      onClick={handleClick}
      aria-label={ariaLabel}
      className={CHIP_CLASSNAME}
    >
      <Wallet className="text-muted-foreground size-3.5" strokeWidth={2.2} aria-hidden="true" />
      <span className="tabular-nums">{balanceLabel}</span>
      {canTopUp && <span className="text-primary">Top up</span>}
    </Link>
  );
}

/**
 * The `<Suspense>` fallback while the top-bar chip's server read resolves. Icon dot + two text
 * bars (balance, "Top up") — see the `SKELETON_CLASSNAME` docblock above for why this shape,
 * not a single flat box.
 */
export function CreditsChipSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" className={SKELETON_CLASSNAME}>
      <span className={`${SKELETON_BAR_CLASSNAME} size-3.5 rounded-full`} />
      <span className={`${SKELETON_BAR_CLASSNAME} h-3 w-14`} />
      <span className={`${SKELETON_BAR_CLASSNAME} h-3 w-10`} />
    </div>
  );
}
