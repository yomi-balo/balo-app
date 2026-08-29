import { log } from '@/lib/logging';
import { loadTopBarWalletData } from '@/lib/credit/wallet-read';
import { CreditsChip } from './credits-chip';

interface CreditsChipSlotProps {
  readonly actorId: string;
  readonly companyId: string;
}

/**
 * BAL-499 (D2) — the async SERVER slot for the top-bar credits chip. Resolves the audience +
 * balance server-side (`loadTopBarWalletData`, a shared read with BAL-402's dashboard card via
 * `resolveWalletAudience`), then hands the projected data to the client leaf.
 *
 * On a read failure it logs at the catch boundary (CLAUDE.md) and returns `null` — the chip
 * HIDES rather than rendering a broken state. Unlike `DashboardWalletSlot` (which renders an
 * error card with a Retry, because it is the page's primary content), this is chrome: a nav
 * ornament failing must not shout, and there is nothing useful to retry inline in the top bar.
 */
export async function CreditsChipSlot({
  actorId,
  companyId,
}: Readonly<CreditsChipSlotProps>): Promise<React.JSX.Element | null> {
  try {
    const { balanceMinor, canTopUp } = await loadTopBarWalletData(actorId, companyId);
    return <CreditsChip balanceMinor={balanceMinor} canTopUp={canTopUp} />;
  } catch (error) {
    log.error('Top-bar credits chip read failed', {
      userId: actorId,
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
