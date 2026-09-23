import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CalendarReconnectNoticeProps {
  readonly onReconnect: () => void;
}

/**
 * The amber in-row notice for `reconnect_needed` (EXPIRED or REVOKED — one shared UX per the
 * apiroc skill). No hooks of its own beyond the passed-in callback, so it stays a server
 * component even though it only ever renders inside the client tree.
 */
export function CalendarReconnectNotice({
  onReconnect,
}: Readonly<CalendarReconnectNoticeProps>): React.JSX.Element {
  return (
    <div className="bg-warning/10 border-warning/30 flex flex-col gap-2.5 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="text-warning-strong mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        <p className="text-foreground text-[12.5px] leading-relaxed">
          We&apos;ve lost access to this calendar — this usually happens after a password change, or
          when calendar access is turned off. Your current availability still shows, but new changes
          won&apos;t sync until you reconnect.
        </p>
      </div>
      {/* Warning-toned, matching the structurally-parallel "Fix permissions" CTA in
          `calendar-sync-pending-notice.tsx` — both sit inside the same amber notice, so the CTA
          colour language should not differ between them. */}
      <Button
        type="button"
        size="sm"
        className="bg-warning hover:bg-warning/90 text-warning-foreground h-11 shrink-0 gap-1.5 shadow-sm sm:h-8"
        onClick={onReconnect}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Reconnect
      </Button>
    </div>
  );
}
