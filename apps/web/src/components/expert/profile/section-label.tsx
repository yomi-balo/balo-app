import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SectionLabelTone = 'primary' | 'accent' | 'warning' | 'success' | 'muted';

const TONE_CLASS: Record<SectionLabelTone, string> = {
  primary: 'text-primary',
  accent: 'text-violet-600 dark:text-violet-400',
  warning: 'text-warning',
  success: 'text-success',
  muted: 'text-muted-foreground',
};

interface SectionLabelProps {
  icon: LucideIcon;
  children: React.ReactNode;
  tone?: SectionLabelTone;
  className?: string;
}

/** Small uppercase, letter-spaced section eyebrow with a leading icon. */
export function SectionLabel({
  icon: Icon,
  children,
  tone = 'muted',
  className,
}: Readonly<SectionLabelProps>): React.JSX.Element {
  const toneClass = TONE_CLASS[tone];
  return (
    <div className={cn('flex items-center gap-1.5', toneClass, className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-[11px] font-bold tracking-[0.07em] uppercase">{children}</span>
    </div>
  );
}
