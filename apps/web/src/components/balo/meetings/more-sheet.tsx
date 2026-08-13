'use client';

import { LayoutGrid, MonitorUp, MoreHorizontal, Settings } from 'lucide-react';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';
import { BackToContextLink } from './back-to-context-link';
import { MeetingMenu, MeetingMenuItem } from './meeting-overlay';
import { MeetingToolbarButton } from './meeting-toolbar-button';

/**
 * BAL-435 — the toolbar's overflow.
 *
 * ⚠⚠ **RAISE HAND IS CUT WHOLE TO BAL-437 (ruling R5).** Not as a local visual, not disabled,
 * not present here, not in the icon imports. A gesture that reaches nobody is a broken
 * affordance dressed as a working one; BAL-437's Ably channel is what makes it real.
 *
 * ⚠ THE SLOT RULE: Chat, Files, People and Reactions are REGISTERED SLOTS owned by BAL-436 /
 * BAL-437, and an unregistered slot renders **NOTHING** — never a disabled row. So today the
 * desktop menu holds Settings (plus the back link), and the mobile menu additionally holds the
 * items the narrow ladder pushed out of the bar.
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
