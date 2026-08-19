import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CalendarReconnectNoticeProps {
  readonly onReconnect: () => void;
}

/**
 * The amber in-card banner for `reconnect_needed` (EXPIRED or REVOKED — one shared UX per the
 * apiroc skill). No hooks of its own beyond the passed-in callback, so it stays a server
 * component even though it only ever renders inside the client tree.
 */
export function CalendarReconnectNotice({
  onReconnect,
}: Readonly<CalendarReconnectNoticeProps>): React.JSX.Element {
  return (
    <div className="bg-warning/5 border-warning/20 mx-5 mt-4 flex flex-col gap-3 rounded-[10px] border p-3.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="text-warning mt-0.5 h-[15px] w-[15px] shrink-0"
          aria-hidden="true"
        />
        <p className="text-foreground text-[13px] leading-relaxed">
          We&apos;ve lost access to this calendar — this usually happens after a password change, or
          when calendar access is turned off. Your current availability still shows, but new changes
          won&apos;t sync until you reconnect.
        </p>
      </div>
      {/* Warning-toned, matching the structurally-parallel "Fix permissions" CTA in
          `calendar-sync-pending-notice.tsx` — both sit inside the same amber banner, so the CTA
          colour language should not differ between them (UX SUGGESTION). */}
      <Button
        type="button"
        size="sm"
        className="bg-warning hover:bg-warning/90 text-warning-foreground shrink-0 gap-1.5 shadow-sm"
        onClick={onReconnect}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Reconnect
      </Button>
    </div>
  );
}
