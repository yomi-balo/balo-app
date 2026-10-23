import { cn } from '@/lib/utils';

interface RequestCardProps {
  children: React.ReactNode;
  /** Primary-tinted border (the prototype's `glow` card). */
  glow?: boolean;
  className?: string;
}

/**
 * Thin balo wrapper over a shadcn-style Card surface, using design-system radius /
 * border tokens (replaces the prototype's inline `Card`/`glow`). Flat by design —
 * the reference cards carry a border and no shadow. Every card on the
 * request-detail page composes this so the surface stays consistent in light +
 * dark mode.
 */
export function RequestCard({
  children,
  glow = false,
  className,
}: Readonly<RequestCardProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'bg-card rounded-2xl border',
        glow ? 'border-primary/40' : 'border-border',
        className
      )}
    >
      {children}
    </div>
  );
}
