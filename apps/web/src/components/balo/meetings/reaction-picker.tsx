'use client';

import { useCallback } from 'react';
import { Smile } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { MEETING_TOOLBAR_MOBILE_MAX_PX } from '@/lib/meetings/meeting-breakpoints';
import { MEETING_REACTIONS, type MeetingReactionEmoji } from '@/lib/meetings/meeting-reactions';
import { MeetingMenu } from './meeting-overlay';
import { MeetingToolbarButton } from './meeting-toolbar-button';

/**
 * BAL-437 — the six-emoji picker.
 *
 * ⚠⚠ IT IS **ABSENT**, NOT DISABLED, WHEN REALTIME IS UNCONFIGURED. The frame renders this
 * component only when `panels.realtime !== null`; a reaction with no transport reaches nobody,
 * which is exactly the "broken affordance dressed as a working one" the slot rule forbids.
 *
 * ⚠ IT REUSES `MeetingMenu` RATHER THAN A FOURTH OVERLAY. That module already owns the §8.3
 * portal rule (portal INTO the frame, or the popover is invisible in fullscreen), the scrim,
 * Escape-to-close and the mobile bottom-sheet swap. A local Popover here would be a fourth copy
 * of a rule that has exactly one implementation on purpose.
 *
 * ⚠ THE PICKER **CLOSES ON SELECTION**, and that is a rate mitigation as well as prototype
 * behaviour: one tap, one invocation, no held-open machine-gun. ⚠⚠ IT IS NOT A THROTTLE — see
 * `send-meeting-reaction.ts`, which states the missing server-side limit and names **BAL-461**.
 *
 * ── ⚠⚠ FOCUS RESTORE IS **NOT** THE DEFAULT HERE, AND THE DOCBLOCK USED TO CLAIM IT WAS ───
 *
 * The old text read *"focus returns to the opener because Radix restores it on close and the
 * trigger stays mounted"*. Mounted, yes — FOCUSABLE, no. This trigger is `hidden md:flex`, and
 * `MeetingMenu` becomes a Radix **Dialog** below the SAME 768px breakpoint. So on a phone the
 * two facts compose into a defect: the menu closes, Radix restores focus to a `display: none`
 * node, the browser refuses, and focus falls to `<body>` — a keyboard or screen-reader user is
 * dumped out of the toolbar in the middle of a live call and has to tab in from the top of the
 * document past everything else on the page.
 *
 * The fix is {@link ReactionPickerProps.mobileOpenerRef}: at mobile widths this component
 * `preventDefault()`s the restore and focuses the **More** button instead — which is genuinely
 * the control the person pressed to get here, since the mobile entry point is `MoreSheet`'s
 * "React" row. Above 768px the trigger IS visible and Radix's default is exactly right, so the
 * handler does nothing at all.
 *
 * ⚠ EVERY TARGET IS ≥44px (`h-11 w-11`), on every breakpoint.
 */

export interface ReactionPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (emoji: MeetingReactionEmoji) => void;
  /**
   * ⚠⚠ WHERE FOCUS GOES WHEN THE **MOBILE** PICKER CLOSES. Below 768px this component's own
   * trigger is `display: none`, so Radix's default restore lands on nothing — see the module
   * docblock. `undefined` ⇒ the default restore is left alone, which is the correct behaviour
   * for a caller that renders this above the breakpoint only.
   */
  readonly mobileOpenerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function ReactionPicker({
  open,
  onOpenChange,
  onSelect,
  mobileOpenerRef,
}: Readonly<ReactionPickerProps>): React.JSX.Element {
  // ⚠ THE SAME BREAKPOINT `MeetingMenu` SWITCHES SHAPE ON, read from the same constant. The two
  // must agree: the Dialog arm and the hidden trigger are the same 768px band by construction.
  const isMobile = useIsMobile(MEETING_TOOLBAR_MOBILE_MAX_PX);

  const pick = useCallback(
    (emoji: MeetingReactionEmoji): void => {
      // ⚠ CLOSE FIRST, THEN SEND. The float renders optimistically inside `onSelect`, so
      // closing first keeps the emoji visible on the stage rather than behind the popover.
      onOpenChange(false);
      onSelect(emoji);
    },
    [onOpenChange, onSelect]
  );

  const onCloseAutoFocus = useCallback(
    (event: Event): void => {
      const opener = mobileOpenerRef?.current;
      // ⚠ DESKTOP, OR NO NODE TO AIM AT ⇒ LEAVE RADIX ALONE. Swallowing the event without a
      // destination is strictly worse than the default it would replace: it guarantees the
      // `<body>` outcome instead of merely risking it.
      if (!isMobile || opener === null || opener === undefined) return;
      event.preventDefault();
      opener.focus();
    },
    [isMobile, mobileOpenerRef]
  );

  return (
    <MeetingMenu
      open={open}
      onOpenChange={onOpenChange}
      label="React"
      onCloseAutoFocus={onCloseAutoFocus}
      trigger={
        /*
          ⚠ DESKTOP BAR ONLY (`hidden md:flex`), MIRRORING SHARE SCREEN EXACTLY — its mobile
          twin is `MoreSheet`'s `md:hidden` "React" row. The MOBILE ladder is a FIXED RULE
          (Mic · Camera · Chat · More · Leave) and a sixth bar control would break it.

          ⚠⚠ THE HIDDEN TRIGGER STILL WORKS ON MOBILE, and that is why `open` is CONTROLLED by
          the frame rather than by this component: below 768px `MeetingMenu` renders a bottom
          Dialog SHEET, which anchors to nothing — so the MoreSheet row can open the picker
          even though this trigger has no box. ⚠ IT IS ALSO WHY `onCloseAutoFocus` EXISTS: a
          node with no box cannot take focus back. See the module docblock.

          ⚠ NO LOCAL `ref` — Radix's `asChild` trigger attaches its own, which is what its
          default focus restore uses. A second ref here would be dead weight.
        */
        <MeetingToolbarButton
          icon={Smile}
          label="React"
          tooltip="Send a reaction"
          size="desktop"
          className="hidden md:flex"
          state={open ? 'active' : 'default'}
          pressed={open}
          onClick={() => onOpenChange(!open)}
        />
      }
    >
      {/*
        ⚠⚠ `role="group"`, **NOT `role="menu"`.** An earlier version used `menu`/`menuitem`,
        which is a PROMISE to assistive tech that this widget implements the menu keyboard
        interface: ONE tab stop, arrow keys to move between items, Home/End. It ships six plain
        tab stops and no arrow handling, so a screen-reader user was told to press ↓ and nothing
        happened — a worse experience than no role at all, because the role is what made them
        try. `group` + a name is the honest description of what this actually is: six ordinary
        buttons that happen to sit together. ⚠ If somebody later adds real roving tabindex, the
        role can come back — but the role must follow the behaviour, never lead it.
      */}
      <div role="group" aria-label="Reactions" className="flex items-center justify-between gap-1">
        {MEETING_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => pick(emoji)}
            // ⚠ THE ACCESSIBLE NAME IS THE GLYPH ITSELF, which every screen reader announces
            // by its Unicode name ("thumbs up"). A hand-written English label would be a
            // second, drifting vocabulary for the same six characters.
            aria-label={emoji}
            className="hover:bg-muted/60 focus-visible:ring-ring inline-flex h-11 w-11 items-center justify-center rounded-xl text-xl transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
    </MeetingMenu>
  );
}
