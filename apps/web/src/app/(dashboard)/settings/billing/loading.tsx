import { WalletWidget } from '@/components/balo/credit/wallet-widget';
import { SectionSkeleton } from '@/components/balo/section/section-states';

/**
 * BAL-503 — Credits & billing's loading skeleton. The widget's own `loading` arm; no new logic.
 *
 * BAL-516 EXTENSION — adds two skeletons matching the two new holder-only sections' shapes, so a
 * slow request doesn't flash an incomplete page: a picker-shaped block (three pulsing pill rows,
 * reusing `SectionSkeleton`'s established pulsing-block visual language, inside the same plain
 * card classes `LowBalanceSection` itself renders) and a single card-row skeleton (a chip +
 * two text lines, mirroring `SavedCardRow`'s shape). This is a fixed loading shell, not a
 * capability-aware one — a member's real render never shows these sections either, so the extra
 * skeleton beat for that case is a one-frame no-op, not a leak (no data is fetched here).
 *
 * BAL-522 EXTENSION — a third block for the new "Billing email" section, in the same order the
 * page renders it (low-balance → payment method → billing email). Without it that card pops in
 * after load and shifts nothing above it but adds height below the fold — exactly the layout
 * shift this file exists to prevent. Shape only: a label bar, an input-shaped bar, a
 * button-shaped bar right-aligned like the real Save.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <WalletWidget state="loading" />

      <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">
        <div className="bg-muted mb-2.5 h-4 w-48 animate-pulse rounded" />
        <SectionSkeleton rows={3} />
      </div>

      <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">
        <div className="bg-muted mb-3 h-4 w-32 animate-pulse rounded" />
        <div
          className="border-border flex items-center gap-3 rounded-xl border p-3.5"
          data-testid="saved-card-row-skeleton"
        >
          <span className="bg-muted h-7 w-[34px] shrink-0 animate-pulse rounded" />
          <div className="flex-1 space-y-2">
            <span className="bg-muted block h-3 w-2/5 animate-pulse rounded" />
            <span className="bg-muted/60 block h-2.5 w-1/3 animate-pulse rounded" />
          </div>
        </div>
      </div>

      <div
        className="border-border bg-card rounded-2xl border p-6 shadow-sm"
        data-testid="billing-email-skeleton"
      >
        <div className="bg-muted mb-3 h-4 w-28 animate-pulse rounded" />
        <div className="bg-muted/60 h-9 w-full animate-pulse rounded-lg" />
        <div className="mt-4 flex justify-end">
          <div className="bg-muted h-9 w-28 animate-pulse rounded-lg" />
        </div>
      </div>
    </div>
  );
}
