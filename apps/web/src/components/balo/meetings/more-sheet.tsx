'use client';

import {
  LayoutGrid,
  MonitorUp,
  MoreHorizontal,
  Paperclip,
  Settings,
  Smile,
  Users,
  Wallet,
} from 'lucide-react';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';
import type { MeetingPanelId } from '@/lib/meetings/meeting-panels';
import { BackToContextLink } from './back-to-context-link';
import { MeetingMenu, MeetingMenuItem } from './meeting-overlay';
import { MeetingToolbarButton } from './meeting-toolbar-button';

/**
 * BAL-435 — the toolbar's overflow.
 *
 * ⚠⚠ **RAISE HAND IS CUT WHOLE — NOW TO BAL-460 (ruling R5).** Not as a local visual, not
 * disabled, not present here, not in the icon imports. A gesture that reaches nobody is a
 * broken affordance dressed as a working one.
 *
 * ⚠⚠ **IT WAS RE-POINTED FROM BAL-437 BECAUSE THE OLD SENTENCE WAS FALSE.** This line used to
 * read *"BAL-437's Ably channel is what makes it real"*. BAL-437 shipped that channel and
 * DISPROVED the claim: it is a fire-and-forget publish seam with NO history replay and NO
 * presence, and a raised hand is not a broadcast. A REACTION fires, floats for 2.2s and is
 * gone; a HAND goes up and STAYS up — it must be visible to somebody who joins AFTER it was
 * raised, must appear in the People panel and on the stage tile, and needs a host "lower hand"
 * act. That is per-connection STATE, which means either Ably Presence — whose `enter` requires
 * the `presence` capability on the CLIENT token, reversing BAL-437's binding subscribe-only
 * invariant (`ably-server.ts`) — or a durable per-meeting hand store plus late-joiner
 * hydration plus an act gate. Both are a design surface, not a checkbox. **BAL-460 owns it.**
 *
 * ⚠ THE SLOT RULE: Chat, Files, People and Reactions are REGISTERED SLOTS owned by BAL-436 /
 * BAL-437, and an unregistered slot renders **NOTHING** — never a disabled row. So the desktop
 * menu holds Settings (plus the back link), and the mobile menu additionally holds the items
 * the narrow ladder pushed out of the bar.
 *
 * ⚠ THE ITEMS THAT DIFFER BY BREAKPOINT ARE SWITCHED IN **CSS**, not in JS: their bar twins
 * carry `hidden md:inline-flex` and these carry `md:hidden`, so nothing flashes on first paint.
 *
 * ⚠⚠ THE LAYOUT ROW SPLITS AT `lg`, NOT AT `md`, AND THAT IS A FIX. `ViewControls` (which owns
 * the layout toggle on the stage) is `hidden lg:flex`, so a row hidden at `md` left **768–1023px
 * with no layout toggle anywhere at all** — an iPad in portrait could not switch speaker ↔
 * gallery by any means.
 */

/**
 * ⚠ SAID OUT LOUD RATHER THAN SILENTLY OMITTED. Screen sharing is missing on iOS Safari and
 * Android Chrome, and a row that simply vanished would read as a Balo bug on a phone the user
 * shares screens from every day at their desk.
 */
export const SCREENSHARE_UNSUPPORTED_LINE = "Screen sharing isn't available in this browser.";

export interface MoreSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** ⚠ Only meaningful while a video layout is up. */
  readonly showLayoutToggle: boolean;
  readonly isGallery: boolean;
  readonly onToggleLayout: () => void;
  readonly isSharingScreen: boolean;
  /** ⚠ A CAPABILITY, NOT A BREAKPOINT — see `SCREENSHARE_UNSUPPORTED_LINE`. */
  readonly canShareScreen: boolean;
  readonly onToggleScreenShare: () => void;
  readonly onOpenSettings: () => void;
  /**
   * BAL-436 — supplied ONLY when the side-panel slot is registered.
   *
   * ⚠ `undefined` ⇒ THE TWO ROWS RENDER **NOTHING**. That is the slot rule, and both GUEST
   * mounts land there structurally (neither mounts the route context that carries the
   * registration). Never a disabled row.
   */
  readonly onTogglePanel?: (id: MeetingPanelId) => void;
  /**
   * BAL-437 — ⚠ SUPPLIED ONLY WHEN REALTIME IS CONFIGURED. `undefined` ⇒ NO Reactions row: a
   * reaction with no transport reaches nobody, and the slot rule forbids the disabled version.
   */
  readonly onOpenReactions?: () => void;
  /**
   * BAL-437 — ⚠ THE **More** TRIGGER'S NODE, handed up so a sibling overlay can return focus to
   * it. `ReactionPicker` is the one caller: below 768px ITS trigger is `display: none`, so Radix
   * cannot restore focus there and this button — the control the person actually pressed to
   * reach the picker — is the correct destination. ⚠ NOTHING HERE READS IT.
   */
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
  /**
   * BAL-403 — ⚠ WHETHER THE **BALANCE** SLOT IS REGISTERED. `false` for every meeting today —
   * see `meeting-panels.ts`. `false`/`undefined` ⇒ NO row, never a disabled one.
   */
  readonly hasBalance?: boolean;
  /** BAL-403 — the same escalation flag the toolbar button's dot carries (OQ2: yes, same flag). */
  readonly balanceAttention?: boolean;
}

export function MoreSheet({
  open,
  onOpenChange,
  showLayoutToggle,
  isGallery,
  onToggleLayout,
  isSharingScreen,
  canShareScreen,
  onToggleScreenShare,
  onOpenSettings,
  onTogglePanel,
  onOpenReactions,
  triggerRef,
  hasBalance = false,
  balanceAttention = false,
}: Readonly<MoreSheetProps>): React.JSX.Element {
  // ⚠ THE SAME STRUCTURAL SIGNAL THE LINK ITSELF USES: no route context ⇒ an anonymous guest,
  // who has no Balo destination. Read here too so the DIVIDER does not render around nothing.
  const { backTo } = useMeetingRoute();

  const close = (run: () => void) => (): void => {
    onOpenChange(false);
    run();
  };

  return (
    <MeetingMenu
      open={open}
      onOpenChange={onOpenChange}
      label="More options"
      trigger={
        <MeetingToolbarButton
          ref={triggerRef}
          icon={MoreHorizontal}
          label="More"
          // ⚠ ONE CONTROL, TWO SIZES, SWITCHED IN CSS — rendering it twice would double the tab
          // order and double what a screen-reader user hears.
          size="mobile"
          className="md:h-12 md:w-12 md:rounded-[14px]"
          state={open ? 'active' : 'default'}
          pressed={open}
          onClick={() => onOpenChange(!open)}
        />
      }
    >
      {/* ⚠ BELOW `lg` ONLY — its stage twin (`ViewControls`) is `hidden lg:flex`. */}
      {showLayoutToggle ? (
        <div className="lg:hidden">
          <MeetingMenuItem
            icon={LayoutGrid}
            label={isGallery ? 'Speaker view' : 'Gallery view'}
            onSelect={close(onToggleLayout)}
          />
        </div>
      ) : null}
      {/* ⚠ MOBILE-ONLY ROW — its bar twin is `hidden md:flex`. ⚠ A `<div>`, not an inline
          `<span>`: `MeetingMenuItem` is a `w-full` block button, and width resolving correctly
          inside an inline element was an accident rather than a design. */}
      <div className="md:hidden">
        {canShareScreen ? (
          <MeetingMenuItem
            icon={MonitorUp}
            label={isSharingScreen ? 'Stop sharing' : 'Share screen'}
            onSelect={close(onToggleScreenShare)}
          />
        ) : (
          <p className="text-muted-foreground px-3 py-3 text-[13px] leading-relaxed">
            {SCREENSHARE_UNSUPPORTED_LINE}
          </p>
        )}
      </div>

      {/*
        ⚠⚠ BAL-436 — THE PEOPLE AND FILES ROWS, `lg:hidden`: their bar twins are `hidden lg:flex`,
        so the split is CSS and nothing flashes on first paint. Rendered only when the slot is
        REGISTERED — an unregistered slot renders NOTHING, never a disabled row.

        ⚠⚠ `lg`, NOT `md`, AND THAT IS THE WHOLE POINT OF THE NUMBER. The panel itself overlays
        below `lg` (`meeting-side-panel.tsx`), and the toolbar's `PanelSlotButtons` are
        `hidden lg:flex`. When these rows were `md:hidden` the 768–1023px band had NO way into
        the panel from the sheet while also showing the desktop buttons — three readers, three
        answers. All three now say `lg`. ⚠ The Share-screen row above stays `md:hidden` on
        purpose: its bar twin is `hidden md:flex`, so that pair agrees with itself.
      */}
      {onTogglePanel === undefined ? null : (
        <div className="lg:hidden">
          <MeetingMenuItem
            icon={Users}
            label="People"
            onSelect={close(() => onTogglePanel('people'))}
          />
          <MeetingMenuItem
            icon={Paperclip}
            label="Files"
            onSelect={close(() => onTogglePanel('files'))}
          />
        </div>
      )}

      {/*
        ⚠⚠ BAL-403 — THE BALANCE ROW, `lg:hidden`: its bar twin (`BalanceSlot`) is `hidden
        lg:flex`, matching People/Files exactly (Decision OQ2: the badge appears here too, driven
        by the SAME `balanceAttention` flag as the toolbar button, with the same auto-open
        ladder). Rendered only when the slot is REGISTERED — `false` for every meeting today.
      */}
      {onTogglePanel === undefined || !hasBalance ? null : (
        <div className="lg:hidden">
          <MeetingMenuItem
            icon={Wallet}
            label={balanceAttention ? 'Balance, needs attention' : 'Balance'}
            badge={balanceAttention}
            onSelect={close(() => onTogglePanel('balance'))}
          />
        </div>
      )}

      {/*
        ⚠⚠ BAL-437 — **THERE IS DELIBERATELY NO `Chat` ROW HERE, AND THAT IS A CONSIDERED
        DEVIATION FROM THE PLAN, NOT AN OMISSION.** Chat's bar twin is the mobile ladder's
        RESERVED SLOT 3 (`meeting-toolbar.tsx`), and unlike People / Files / Share screen that
        button carries NO breakpoint class at all — it is visible from 320px up. A row here
        would therefore be a SECOND live control for the same slot at every width, which
        doubles the tab order and doubles what a screen-reader user hears — the exact rule this
        file's own `size="mobile"` comment states for the More trigger. The People/Files rows
        above exist precisely because their bar twins ARE hidden below `lg`; Chat's is not.

        ⚠ AND THERE IS NO `hasChat` PROP EITHER. An earlier draft threaded one "for a future
        row"; it was dead weight this component never read, and a prop that gates nothing is a
        claim about behaviour that does not exist. Whoever adds a Chat row here must first
        decide what its bar twin does — which is the decision the prop was pretending to
        preserve. `meeting-toolbar.tsx` owns `hasChat` because it owns the control.
      */}

      {/*
        ⚠ BAL-437 — REACTIONS, `md:hidden`, mirroring Share screen exactly: its bar twin is
        `hidden md:inline-flex`, so this pair agrees with itself at every width. Absent
        entirely when realtime is unconfigured — a reaction with no transport reaches nobody.
      */}
      {onOpenReactions === undefined ? null : (
        <div className="md:hidden">
          <MeetingMenuItem icon={Smile} label="React" onSelect={close(onOpenReactions)} />
        </div>
      )}

      <MeetingMenuItem icon={Settings} label="Camera and sound" onSelect={close(onOpenSettings)} />

      {/* ⚠ THE BACK LINK'S LAST HOME. Never in the top bar — and absent entirely for a guest, so
          the divider is conditional on the same signal rather than framing an empty row. */}
      {backTo === null ? null : (
        <div className="border-border mt-1 border-t px-1 pt-1">
          <BackToContextLink />
        </div>
      )}
    </MeetingMenu>
  );
}
