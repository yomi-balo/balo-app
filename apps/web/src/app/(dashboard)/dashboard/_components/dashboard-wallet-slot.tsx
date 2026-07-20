import { log } from '@/lib/logging';
import { loadDashboardWalletData } from '@/lib/credit/wallet-read';
import { DashboardWalletCard } from './dashboard-wallet-card';

interface DashboardWalletSlotProps {
  readonly actor: { id: string };
  readonly companyId: string;
}

/**
 * BAL-402 — the async SERVER slot for the dashboard wallet card. It resolves the capability lens
 * + balance + indicative FX server-side (via `loadDashboardWalletData`), then hands the projected,
 * serialisable union to the client card. Wrapped in `<Suspense>` by the page so the rest of the
 * dashboard paints while these reads resolve. On a read failure it logs at the catch boundary
 * (per CLAUDE.md) and renders the widget's shipped `error` state with a Retry — no route-level
 * `error.tsx` that would blow away the whole dashboard.
 */
export async function DashboardWalletSlot({
  actor,
  companyId,
}: Readonly<DashboardWalletSlotProps>): Promise<React.JSX.Element> {
  try {
    const data = await loadDashboardWalletData(actor, companyId);
    return <DashboardWalletCard data={data} />;
  } catch (error) {
    log.error('Dashboard wallet read failed', {
      userId: actor.id,
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return <DashboardWalletCard data={{ kind: 'error' }} />;
  }
}
