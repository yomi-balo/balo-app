import type { LucideIcon } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';
import { cn } from '@/lib/utils';

interface SettingsPageHeaderProps {
  readonly icon: LucideIcon;
  /** The tab's accent, passed to `IconBadge` (which derives its tint and border from it). */
  readonly color: string;
  readonly title: string;
  readonly description: React.ReactNode;
  /** Extra lines under the description (e.g. Schedule's timezone line). */
  readonly children?: React.ReactNode;
  readonly className?: string;
}

/**
 * The one title block every expert-settings tab opens with: a 44px tinted icon on the left, the
 * tab's h1 and a one-line description stacked beside it.
 */
export function SettingsPageHeader({
  icon,
  color,
  title,
  description,
  children,
  className,
}: SettingsPageHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <IconBadge icon={icon} color={color} size={44} iconSize={22} />
      <div className="flex min-w-0 flex-col gap-2.5">
        <div>
          <h1 className="text-foreground text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground mt-0.5 max-w-[540px] text-sm leading-relaxed">
            {description}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
