import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectPath } from './constants';

interface PathCardProps {
  path: ProjectPath;
  onClick?: () => void;
}

/**
 * Entry-path selector card on the `start` step. The enabled (manual) variant is
 * a clickable button with a hover lift; the disabled (AI) variant is inert,
 * dimmed + `cursor-not-allowed` with no click handler, and surfaces its reason
 * for being unavailable as a visible muted "Coming soon" cue beside the badge
 * plus an `aria-label` so it's announced to assistive tech.
 */
export function PathCard({ path, onClick }: Readonly<PathCardProps>): React.JSX.Element {
  const { icon: Icon, title, desc, badge, disabled, comingSoonLabel } = path;

  // When disabled with a reason, announce it to AT users (the visible cue covers
  // sighted users) so the card isn't an unexplained dead end.
  const ariaLabel = disabled && comingSoonLabel ? `${title} — ${comingSoonLabel}` : undefined;

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'border-border bg-card focus-visible:ring-ring group flex w-full items-center gap-4 rounded-2xl border p-[18px] text-left transition-all focus-visible:ring-2 focus-visible:outline-none',
        disabled
          ? 'cursor-not-allowed opacity-60'
          : 'hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-[0_4px_18px_rgba(99,102,241,0.1)]'
      )}
    >
      <span className="border-primary/25 bg-primary/10 text-primary flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] border">
        <Icon className="h-5.5 w-5.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-foreground text-[15px] font-bold">{title}</span>
          {badge && (
            <span className="border-primary/30 bg-primary/10 text-primary rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.04em]">
              {badge}
            </span>
          )}
          {comingSoonLabel && (
            <span className="text-muted-foreground text-[11px] font-medium">{comingSoonLabel}</span>
          )}
        </span>
        <span className="text-muted-foreground mt-1 block text-[13px] leading-relaxed">{desc}</span>
      </span>
      <ChevronRight
        className={cn(
          'h-4.5 w-4.5 shrink-0',
          disabled ? 'text-muted-foreground/60' : 'text-muted-foreground group-hover:text-primary'
        )}
        aria-hidden="true"
      />
    </button>
  );
}
