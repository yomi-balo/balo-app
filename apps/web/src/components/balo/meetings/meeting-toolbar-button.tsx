'use client';

import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * BAL-435 — **THE ONE CONTROL PRIMITIVE** for the toolbar, the stage's ViewControls and
 * PreJoin's inline controls.
 *
 * ⚠⚠ NO `Toggle` / `ToggleGroup` PRIMITIVE IS ADDED, DELIBERATELY. shadcn's `Toggle` is a Radix
 * `Toggle` with its own size/variant CVA that would fight the 48×48 `rounded-[14px]` desktop
 * spec, the 46px full-round mobile spec AND the three-way `default | active | danger`
 * treatment — we would override every variant it ships. These are not `Toggle` semantics anyway:
 * they are icon buttons whose pressed-ness is `aria-pressed`, which a plain button expresses
 * exactly.
 *
 * ⚠⚠ `label` BECOMES **BOTH** THE `aria-label` AND THE TOOLTIP, FROM ONE STRING. CLAUDE.md: a
 * hover tooltip is NEVER the sole explanation — mobile cannot hover.
 *
 * ⚠ THERE IS NO `disabled` STATE, ANYWHERE. An unregistered slot renders NOTHING: a greyed-out
 * Chat icon reads "chat is broken", an absent one reads "this call doesn't have chat".
 *
 * ⚠ `TooltipProvider` IS MOUNTED BY `meeting-frame-impl.tsx`, not at the app root (verified: the
 * only three mounts in the app are local ones in the sidebar, the admin health panel and the
 * expert card). Every component test that renders the frame therefore gets working tooltips with
 * no per-file wrapper.
 */

export type MeetingToolbarButtonState = 'default' | 'active' | 'danger';
export type MeetingToolbarButtonSize = 'desktop' | 'mobile' | 'stage';

export interface MeetingToolbarButtonProps {
  readonly icon: LucideIcon;
  /**
   * ⚠⚠ THE ACCESSIBLE NAME. When the button carries `pressed`, this MUST BE STABLE across the
   * two states — a name that changes while `aria-pressed` flips reads as *"Unmute, toggle button,
   * pressed"*, which parses as "unmute is on" and means the opposite of the truth. So a toggle
   * names the THING ("Microphone") and lets `aria-pressed` carry the state; the changing action
   * wording lives in {@link MeetingToolbarButtonProps.tooltip}, which is a DESCRIPTION and is
   * allowed to change.
   */
  readonly label: string;
  /**
   * The hover/focus tooltip, when it should say something other than the name — i.e. the ACTION
   * ("Mute" / "Unmute") beside a stable name ("Microphone").
   *
   * ⚠ Radix exposes tooltip content as `aria-describedby` when the trigger already has a name, so
   * this never becomes the accessible name and may change freely. ⚠ A tooltip is still NEVER the
   * sole explanation (CLAUDE.md) — `label` always carries one.
   */
  readonly tooltip?: string;
  readonly state?: MeetingToolbarButtonState;
  /** → `aria-pressed`. ⚠ OMIT for a non-toggle: a button that is not a toggle must not claim to be. */
  readonly pressed?: boolean;
  readonly size?: MeetingToolbarButtonSize;
  readonly onClick: () => void;
  readonly className?: string;
}

/** 48px desktop / 46px mobile — both above the 44px minimum. 34px only for the stage overlay. */
const SIZE_CLASSES: Record<MeetingToolbarButtonSize, string> = {
  desktop: 'h-12 w-12 rounded-[14px]',
  mobile: 'h-[46px] w-[46px] rounded-full',
  stage: 'h-[34px] w-[34px] rounded-lg',
};

/**
 * ⚠⚠ `danger` IS A **FILLED** DESTRUCTIVE, NOT A 15% WASH WITH `text-destructive` ON IT.
 *
 * In `.dark` the repo's `--destructive` is `oklch(0.4 0.135 25.8)` — a DARK red meant as a fill
 * behind near-white text. As a FOREGROUND on the frame's `oklch(0.147)` background it rendered at
 * roughly 2.6:1, under the 3:1 floor for UI components, with the 15% wash behind it effectively
 * invisible: "you are muted", the single most consulted state in a call UI, was the dimmest thing
 * on the toolbar. The design's own PreJoin spec already said the off state is `bg-destructive`
 * (§5.1); this makes the toolbar agree with it.
 */
const STATE_CLASSES: Record<MeetingToolbarButtonState, string> = {
  default: 'bg-white/6 border-border text-foreground border',
  active: 'bg-primary/15 text-primary border border-transparent',
  danger: 'bg-destructive text-destructive-foreground border border-transparent',
};

const ICON_SIZE: Record<MeetingToolbarButtonSize, string> = {
  desktop: 'h-5 w-5',
  mobile: 'h-5 w-5',
  stage: 'h-[17px] w-[17px]',
};

/**
 * ⚠ `forwardRef` IS LOAD-BEARING: this is used as a Radix `asChild` trigger for the More menu and
 * the host's leave menu, and Radix needs to attach a ref to the real DOM node.
 */
export const MeetingToolbarButton = forwardRef<HTMLButtonElement, MeetingToolbarButtonProps>(
  function MeetingToolbarButton(
    {
      icon: Icon,
      label,
      tooltip,
      state = 'default',
      pressed,
      size = 'desktop',
      onClick,
      className,
    },
    ref
  ) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            aria-label={label}
            // ⚠ ABSENT, not `false`, when this is not a toggle.
            {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
            className={cn(
              'focus-visible:ring-ring flex shrink-0 items-center justify-center transition-colors focus-visible:ring-2 focus-visible:outline-none active:scale-[0.98]',
              SIZE_CLASSES[size],
              STATE_CLASSES[state],
              className
            )}
          >
            <Icon className={ICON_SIZE[size]} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        {/*
          ⚠ THE TOOLTIP IS A **DESCRIPTION**, and it defaults to the accessible name. It differs
          only where the name must stay stable for `aria-pressed` while the ACTION wording
          changes — see the `label` / `tooltip` docblocks.
        */}
        <TooltipContent>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    );
  }
);
