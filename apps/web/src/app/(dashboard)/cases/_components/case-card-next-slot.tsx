'use client';

import Link from 'next/link';
import { CalendarPlus, CircleHelp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  CaseBookingParts,
  NextSlotView,
  QuietSlotIcon,
  SlotAction,
} from '../_lib/cases-index-presentation';
import type { CasesIndexClickHandler } from './cases-index-click';

/**
 * BAL-567 — a card's "what happens next" slot: the booked stub, or the quiet no-booking one.
 *
 * ⚠⚠ THIS COMPONENT DECIDES NOTHING. Which of the eight states produces which slot is a DATA
 * TABLE (`NEXT_SLOT_BY_STATE`, in `cases-index-presentation.ts`); this file renders the two
 * shapes that table can return. Eight JSX branches here would be eight places for the copy to
 * drift and the exact shape SonarCloud's duplication gate flags.
 *
 * ⚠ EVERY ACTION OPENS THE CASE (or, for the two booking actions, the expert's profile). The
 * index carries NO capability-gated act affordance, so no button here can fail — see
 * `NextSlotContext`'s docblock for why that is a rule and not an accident.
 */

const QUIET_SLOT_ICONS: Readonly<Record<QuietSlotIcon, LucideIcon>> = {
  'calendar-plus': CalendarPlus,
  'circle-help': CircleHelp,
};

interface NextSlotProps {
  readonly slot: NextSlotView;
  readonly onTrack: CasesIndexClickHandler;
}

export function CaseCardNextSlot({ slot, onTrack }: Readonly<NextSlotProps>): React.JSX.Element {
  if (slot.kind === 'stub') {
    return (
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <BookedStub booking={slot.booking} label={slot.label} note={slot.note} />
        <SlotActionButton action={slot.action} onTrack={onTrack} />
      </span>
    );
  }
  const Icon = QUIET_SLOT_ICONS[slot.icon];
  return (
    <span className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="border-border text-muted-foreground inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-dashed"
      >
        <Icon className="size-4" />
      </span>
      <span className="block min-w-0 flex-1">
        <span className="text-muted-foreground block text-[13.5px] font-semibold">
          {slot.title}
        </span>
        {slot.sub !== null && (
          <span className="text-muted-foreground/80 block text-[12.5px]">{slot.sub}</span>
        )}
      </span>
      <SlotActionButton action={slot.action} onTrack={onTrack} />
    </span>
  );
}

/** The little calendar leaf + the booking's own lines. Shared by every booked state. */
function BookedStub({
  booking,
  label,
  note,
}: Readonly<{
  booking: CaseBookingParts;
  label: string | null;
  note: string | null;
}>): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="ring-primary/30 block w-11 shrink-0 overflow-hidden rounded-[10px] bg-white text-center shadow-sm ring-1 dark:bg-transparent"
      >
        <span className="bg-primary text-primary-foreground block text-[10px] leading-4 font-semibold">
          {booking.mon}
        </span>
        <span className="text-foreground block text-lg leading-7 font-bold tabular-nums">
          {booking.day}
        </span>
      </span>
      <span className="block min-w-0">
        {label !== null && (
          <span className="text-muted-foreground/80 block text-[11.5px]">{label}</span>
        )}
        <span className="text-foreground block text-[13.5px] font-semibold">
          {booking.dow}, {booking.time}
        </span>
        <span className="text-muted-foreground block text-[12.5px]">
          {booking.relative}, {booking.durationMinutes} min
        </span>
        {note !== null && (
          // ⚠ RAW AMBER, NOT `text-warning` — at 12.5px this is normal-size text and owes AA
          // 4.5:1 on the card; `--warning` (oklch L .77) lands ≈2.1:1 while amber-700 clears it.
          // The same pairing `up-next-row.tsx` documents at length.
          <span className="mt-0.5 block text-[12.5px] font-medium text-amber-700 dark:text-amber-400">
            {note}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * ⚠ AN ABSENT ACTION, NEVER A DISABLED ONE (the case surface's own rule: "an absent action beats
 * a dead one"). `bookAction` already returns `null` when the expert has no username, so this
 * renders nothing rather than a link to `/experts/null`.
 */
function SlotActionButton({
  action,
  onTrack,
}: Readonly<{
  action: SlotAction | null;
  onTrack: CasesIndexClickHandler;
}>): React.JSX.Element | null {
  if (action === null) return null;
  return (
    <Button
      asChild
      size="sm"
      variant="outline"
      className={cn(
        'shrink-0',
        action.tone === 'amber' &&
          'border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400'
      )}
    >
      <Link href={action.href} onClick={() => onTrack(action.target)}>
        {action.label}
      </Link>
    </Button>
  );
}
