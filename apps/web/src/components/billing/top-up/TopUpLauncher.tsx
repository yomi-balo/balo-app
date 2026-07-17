'use client';

import { ResponsiveModal, TopUpDialog } from './TopUpDialog';
import { MemberWalletNudge } from './MemberWalletNudge';
import type { WalletSnapshot, DisplayFxSnapshot } from './types';

interface TopUpLauncherProps {
  /** The affordance that opens the surface (e.g. a wallet-widget "Top up" button), rendered
   * `asChild` into the Dialog/Sheet trigger. */
  readonly trigger: React.ReactNode;
  /**
   * Whether the acting user holds MANAGE_BILLING for the company. Resolved by a Server
   * Component (`hasCapability(user, CAPABILITIES.MANAGE_BILLING, { companyId })` is server-only,
   * exactly as the `/billing/top-up` route does it) and passed in — never resolved client-side.
   */
  readonly canManageBilling: boolean;
  /** The wallet snapshot (present for a MANAGE_BILLING holder; may be null for a member). */
  readonly wallet: WalletSnapshot | null;
  readonly fx: DisplayFxSnapshot | null;
  /** Team balance for the member-variant surface. */
  readonly balanceMinor: number;
  /** The billing holder's display name for the member nudge copy. */
  readonly adminLabel: string;
}

/**
 * BAL-377 launcher — resolves the capability lens to the right surface (design "never sees this
 * screen"): a MANAGE_BILLING holder gets the composer Dialog/Sheet; any other member gets the
 * member-variant nudge surface. Capability is resolved server-side by the caller and passed as
 * `canManageBilling` (mirrors the `/billing/top-up` route). Ready to drop over any launcher
 * context (wallet widget, billing settings, in-session low-balance nudge); the standalone route
 * keeps working independently.
 */
export function TopUpLauncher({
  trigger,
  canManageBilling,
  wallet,
  fx,
  balanceMinor,
  adminLabel,
}: Readonly<TopUpLauncherProps>) {
  if (canManageBilling && wallet) {
    return <TopUpDialog trigger={trigger} wallet={wallet} fx={fx} />;
  }

  return (
    <ResponsiveModal
      trigger={trigger}
      title="Team balance"
      description="View your team balance and nudge a billing admin to top up."
    >
      {() => <MemberWalletNudge balanceMinor={balanceMinor} adminLabel={adminLabel} fx={fx} />}
    </ResponsiveModal>
  );
}
