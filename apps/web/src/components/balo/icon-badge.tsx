import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface IconBadgeProps {
  icon: LucideIcon;
  color: string;
  size?: number;
  iconSize?: number;
  className?: string;
}

export function IconBadge({
  icon: Icon,
  color,
  size = 40,
  iconSize = 20,
  className,
}: IconBadgeProps): React.JSX.Element {
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center', className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        backgroundColor: `${color}12`,
        border: `1px solid ${color}25`,
      }}
    >
      <Icon style={{ color, width: iconSize, height: iconSize }} aria-hidden="true" />
    </div>
  );
}
