import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ROOM_SETTING_UP_LABEL,
  ROOM_SETTING_UP_SHORT_LABEL,
} from '@/lib/meetings/room-setting-up-copy';

interface RoomSettingUpSlotProps {
  readonly variant: 'button' | 'chip';
  readonly label?: 'long' | 'short';
  readonly className?: string;
}

/**
 * BAL-581 — the JOIN SLOT while a meeting's call room is not ready. NON-INTERACTIVE, and
 * deliberately NOT `JoinCountdown` (whose docblock forbids reuse for a control that may stay out of
 * reach) nor a disabled `JoinMeetingButton` (which renders only inside the join window, live).
 * Occupies the same place and size as the Join it replaces; tokens only; dark-mode safe.
 *
 * ⚠ NOT `role="status"`: it is page content present at render, not an update — nothing here
 * changes after mount, so there is nothing to announce. `button`: the label text is visible
 * inline, giving it an accessible name for free. `chip`: the visible content is icon-only
 * (`aria-hidden`), so an `sr-only` span carries the accessible name, and `title` surfaces the
 * same text on hover for sighted pointer users.
 */
export function RoomSettingUpSlot({
  variant,
  label = 'long',
  className,
}: Readonly<RoomSettingUpSlotProps>): React.JSX.Element {
  const text = label === 'short' ? ROOM_SETTING_UP_SHORT_LABEL : ROOM_SETTING_UP_LABEL;

  if (variant === 'chip') {
    return (
      <span
        title={ROOM_SETTING_UP_LABEL}
        className={cn(
          'bg-muted text-muted-foreground inline-flex size-6 items-center justify-center rounded-full',
          className
        )}
      >
        <Hourglass className="size-3" aria-hidden="true" />
        <span className="sr-only">{ROOM_SETTING_UP_LABEL}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'border-border bg-muted/40 text-muted-foreground inline-flex items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] font-medium',
        className
      )}
    >
      <Hourglass className="size-3.5" aria-hidden="true" />
      {text}
    </span>
  );
}
