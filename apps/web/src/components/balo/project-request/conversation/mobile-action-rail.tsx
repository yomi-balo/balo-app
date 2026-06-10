'use client';

import { Calendar, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MobileActionRailProps {
  /** Hidden while the composer is focused (keyboard up — thumb zone is busy). */
  visible: boolean;
  showCall: boolean;
  callLabel: string;
  callPending: boolean;
  /** A5 stub CTA — rendered disabled; `quiet` defers to the nudge. */
  proposalCta: { label: string; quiet: boolean } | null;
  onCall: () => void;
}

/**
 * Mobile action rail (`lg:hidden`) — BELOW the composer, anchored at the true
 * bottom (thumb zone). Surfaces the call CTA (mock seam) + the primary
 * proposal commit action (A5 stub, disabled). Returns null when nothing is
 * actionable; hides while the composer is focused (keyboard up).
 */
export function MobileActionRail({
  visible,
  showCall,
  callLabel,
  callPending,
  proposalCta,
  onCall,
}: Readonly<MobileActionRailProps>): React.JSX.Element | null {
  if (!visible || (!showCall && proposalCta === null)) return null;

  return (
    <div className="border-border bg-muted/40 flex items-center gap-2 border-t px-3.5 py-2.5 lg:hidden">
      {showCall && (
        <button
          type="button"
          onClick={onCall}
          disabled={callPending}
          className="border-border bg-card text-muted-foreground focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[11px] border px-3.5 text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          {callPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Calendar className="h-4 w-4" aria-hidden="true" />
          )}
          {callLabel}
        </button>
      )}
      {proposalCta !== null && (
        <button
          type="button"
          disabled
          aria-disabled="true"
          className={cn(
            'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[11px] px-4 text-sm font-bold opacity-60',
            proposalCta.quiet
              ? 'border-primary/30 bg-primary/5 text-primary border'
              : 'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500'
          )}
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          {proposalCta.label}
        </button>
      )}
    </div>
  );
}
