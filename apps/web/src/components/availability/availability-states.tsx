import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * BAL-236 — the shared shell for every non-content state (loading, empty, error, degraded,
 * confirmed). One place spacing, icon treatment and dark mode are defined for all of them.
 */

/** Skeleton in the SHAPE of the two-panel layout — a 7×5 pulse grid left, six pulse rows
 *  right. Never a spinner (`balo-ui-skill`). */
export function AvailabilitySkeleton(): React.JSX.Element {
  return (
    // ⚠ `<output>`, NOT `role="status"` on a div (SonarCloud S6819 — escapes local lint, fails
    // the PR gate). `<output>` maps to role `status`, so screen-reader behaviour and any
    // `getByRole('status')` query are unchanged. Matches `calendar-connections-skeleton.tsx` in
    // the same feature area, and the sibling stale-filter warning in `availability-slots-panel`.
    <output
      className="border-border bg-border grid grid-cols-1 gap-px overflow-hidden rounded-xl border md:grid-cols-[minmax(0,1fr)_300px]"
      aria-label="Loading availability"
    >
      <div className="bg-card p-6">
        <div className="bg-muted mb-5 h-4 w-40 animate-pulse rounded" />
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 35 }, (_, i) => i).map((i) => (
            <div
              key={`cal-cell-${i}`}
              className="bg-muted aspect-square animate-pulse rounded-lg"
            />
          ))}
        </div>
      </div>
      <div className="bg-card p-6">
        <div className="bg-muted mb-4 h-4 w-32 animate-pulse rounded" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => i).map((i) => (
            <div key={`row-${i}`} className="bg-muted h-11 w-full animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    </output>
  );
}

export type AvailabilityMessageTone = 'muted' | 'warning' | 'destructive' | 'success';

interface AvailabilityMessageProps {
  icon: ReactNode;
  title: string;
  body?: string;
  tone?: AvailabilityMessageTone;
  action?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

const TONE_ICON_CLASS: Record<AvailabilityMessageTone, string> = {
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
  success: 'text-success',
};

const TONE_BG_CLASS: Record<AvailabilityMessageTone, string> = {
  muted: 'bg-muted',
  warning: 'bg-warning/10',
  destructive: 'bg-destructive/10',
  success: 'bg-success/10',
};

/** Icon + title + body + optional action — the shared shape for `select a date`,
 *  `not_configured`, `no_slots`, `unavailable`, `error`, `not_published` and `confirmed`. */
export function AvailabilityMessage({
  icon,
  title,
  body,
  tone = 'muted',
  action,
  actionLabel,
  onAction,
}: Readonly<AvailabilityMessageProps>): React.JSX.Element {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center px-6 py-8 text-center">
      <div
        className={`mb-3.5 flex h-11 w-11 items-center justify-center rounded-full ${TONE_BG_CLASS[tone]}`}
      >
        <span className={TONE_ICON_CLASS[tone]}>{icon}</span>
      </div>
      <p className="text-foreground mb-1 text-sm font-medium">{title}</p>
      {body && (
        <p className="text-muted-foreground max-w-[240px] text-[13px] leading-relaxed">{body}</p>
      )}
      {actionLabel && onAction && (
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {action}
    </div>
  );
}
