import {
  Bell,
  Briefcase,
  CalendarCheck,
  FolderKanban,
  Link2,
  MessageSquare,
  Sparkles,
  Star,
  UserRound,
  Users,
  Video,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  notificationKindOf,
  type NotificationKindIcon,
  type NotificationKindTone,
} from './notification-arrival';

const ICONS: Record<NotificationKindIcon, LucideIcon> = {
  CalendarCheck,
  Video,
  Briefcase,
  MessageSquare,
  FolderKanban,
  Sparkles,
  Wallet,
  Link2,
  UserRound,
  Users,
  Star,
  Bell,
};

const TONES: Record<NotificationKindTone, string> = {
  primary: 'bg-primary/10 text-primary',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
  muted: 'bg-muted text-muted-foreground',
};

interface NotificationKindBadgeProps {
  event: string;
  size?: number;
  dimmed?: boolean;
  stacked?: boolean;
}

export function NotificationKindBadge({
  event,
  size = 32,
  dimmed = false,
  stacked = false,
}: Readonly<NotificationKindBadgeProps>): React.JSX.Element {
  const { icon, tone } = notificationKindOf(event);
  const Icon = ICONS[icon];
  return (
    <span
      data-slot="notification-kind-badge"
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center',
        TONES[tone],
        dimmed && 'opacity-60',
        stacked && 'ring-popover ring-2'
      )}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
    >
      <Icon style={{ width: Math.round(size * 0.47), height: Math.round(size * 0.47) }} />
    </span>
  );
}

const MAX_STACKED = 3;

export function NotificationKindStack({
  items,
}: Readonly<{ items: readonly { id: string; event: string }[] }>): React.JSX.Element {
  return (
    <span className="flex shrink-0 -space-x-3 pt-0.5" aria-hidden="true">
      {items.slice(0, MAX_STACKED).map((item) => (
        <span key={item.id}>
          <NotificationKindBadge event={item.event} size={32} stacked />
        </span>
      ))}
    </span>
  );
}
