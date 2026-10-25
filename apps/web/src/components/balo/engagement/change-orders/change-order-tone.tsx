import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** The semantic tones a change-order surface draws from (tokens, never palette colours). */
export type ChangeOrderTone = 'warning' | 'muted' | 'primary' | 'success' | 'info' | 'destructive';

const PILL_CLASS: Record<ChangeOrderTone, string> = {
  warning: 'text-warning bg-warning/10 border-warning/25',
  muted: 'text-muted-foreground bg-muted border-border',
  primary: 'text-primary bg-primary/10 border-primary/20',
  success: 'text-success bg-success/10 border-success/20',
  info: 'text-info bg-info/10 border-info/25',
  destructive: 'text-destructive bg-destructive/10 border-destructive/25',
};

const BANNER_CLASS: Record<ChangeOrderTone, string> = {
  warning: 'border-warning/25 bg-warning/10',
  muted: 'border-border bg-muted/50',
  primary: 'border-primary/25 bg-primary/10',
  success: 'border-success/25 bg-success/10',
  info: 'border-info/25 bg-info/10',
  destructive: 'border-destructive/25 bg-destructive/10',
};

const BANNER_ICON_CLASS: Record<ChangeOrderTone, string> = {
  warning: 'text-warning',
  muted: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success',
  info: 'text-info',
  destructive: 'text-destructive',
};

/** The view model's pill tone names (the prototype's palette) mapped onto tokens. */
export const VIEW_TONE: Record<'amber' | 'slate' | 'violet' | 'emerald', ChangeOrderTone> = {
  amber: 'warning',
  slate: 'muted',
  violet: 'primary',
  emerald: 'success',
};

interface TonePillProps {
  tone?: ChangeOrderTone;
  icon?: LucideIcon;
  children: React.ReactNode;
}

export function TonePill({
  tone = 'muted',
  icon: Icon,
  children,
}: Readonly<TonePillProps>): React.JSX.Element {
  return (
    <Badge variant="outline" className={cn('shrink-0', PILL_CLASS[tone])}>
      {Icon !== undefined && <Icon className="size-3" aria-hidden />}
      {children}
    </Badge>
  );
}

interface ToneBannerProps {
  tone: ChangeOrderTone;
  icon: LucideIcon;
  /** The accessible region name. */
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

/** A flat, bordered notice with a leading icon and an optional trailing action cluster. */
export function ToneBanner({
  tone,
  icon: Icon,
  label,
  action,
  children,
}: Readonly<ToneBannerProps>): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border px-4 py-3',
        BANNER_CLASS[tone]
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon className={cn('mt-0.5 size-4 shrink-0', BANNER_ICON_CLASS[tone])} aria-hidden />
        <div className="text-foreground min-w-0 text-sm leading-relaxed">{children}</div>
      </div>
      {action !== undefined && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </section>
  );
}
