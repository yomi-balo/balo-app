'use client';

import { Mic, MicOff, MonitorUp, Video, VideoOff } from 'lucide-react';
import { LeaveControl } from './leave-control';
import { MeetingToolbarButton } from './meeting-toolbar-button';
import { MoreSheet } from './more-sheet';

/**
 * BAL-435 — the sticky bottom toolbar.
 *
 * ── ⚠⚠ THE MOBILE LADDER IS A FIXED RULE, NOT A RESPONSIVE ACCIDENT ─────────────────────────
 *
 * From 320px to 767px the bar holds **Mic · Camera · Chat · More · Leave** and nothing else.
 * Chat is BAL-437's slot, so its cell is EMPTY today — but the ORDER is already encoded, so Chat
 * drops into slot 3 with no layout change when it lands.
 *
 * ⚠ THE BREAKPOINT IS DONE IN **CSS** (`hidden md:inline-flex`), not with `useIsMobile`.
 * `useIsMobile` renders `false` on the first paint, so a JS-gated ladder flashes the DESKTOP bar
 * on every mobile join — and `useIsMobile`'s own default is a 1024px TABLET split, which would
 * put a phone toolbar on a 900px tablet.
 *
 * ⚠ **NO CONTROL HERE IS EVER `disabled`.** An unregistered slot renders nothing at all: a
 * greyed-out Chat icon reads "chat is broken", an absent one reads "this call doesn't have chat".
 *
 * ⚠ FULLSCREEN IS NEVER IN THE TOOLBAR ON ANY BREAKPOINT — it is a ViewControl, and it is
 * desktop-only.
 */

export interface MeetingToolbarProps {
  readonly micOn: boolean;
  readonly cameraOn: boolean;
  readonly onToggleMic: () => void;
  readonly onToggleCamera: () => void;
  readonly isSharingScreen: boolean;
  /**
   * ⚠⚠ A **CAPABILITY**, NOT A BREAKPOINT. `getDisplayMedia` does not exist on iOS Safari or
   * Android Chrome; where it is missing the control is ABSENT rather than present-and-silent.
   */
  readonly canShareScreen: boolean;
  readonly onToggleScreenShare: () => void;
  readonly showLayoutToggle: boolean;
  readonly isGallery: boolean;
  readonly onToggleLayout: () => void;
  readonly onOpenSettings: () => void;
  readonly moreOpen: boolean;
  readonly onMoreOpenChange: (open: boolean) => void;
  /** ⚠⚠ THE SERVER'S `host_meetings` VERDICT — the only input to the end-for-everyone branch. */
  readonly isOwner: boolean;
  readonly contextNoun: string;
  readonly isCase: boolean;
  readonly onLeave: () => void;
  readonly onEndForEveryone: () => void;
  readonly isEnding: boolean;
}

export function MeetingToolbar({
  micOn,
  cameraOn,
  onToggleMic,
  onToggleCamera,
  isSharingScreen,
  canShareScreen,
  onToggleScreenShare,
  showLayoutToggle,
  isGallery,
  onToggleLayout,
  onOpenSettings,
  moreOpen,
  onMoreOpenChange,
  isOwner,
  contextNoun,
  isCase,
  onLeave,
  onEndForEveryone,
  isEnding,
}: Readonly<MeetingToolbarProps>): React.JSX.Element {
  return (
    <div className="border-border flex h-[88px] shrink-0 items-center justify-between border-t px-4 pb-[env(safe-area-inset-bottom)] md:h-24 md:justify-center md:gap-2.5">
      <div className="flex items-center gap-2.5">
        {/*
          ⚠ ONE COMPONENT, TWO SIZES, SWITCHED IN CSS. Rendering the control twice (once per
          breakpoint) would double the tab order and double the `aria-label`s a screen-reader
          user hears.
        */}
        {/*
          ⚠⚠ THE ACCESSIBLE NAME IS THE **THING**, THE TOOLTIP IS THE **ACTION**. `aria-pressed`
          beside a name that changed announced *"Unmute, toggle button, pressed"* — which parses
          as "unmute is on", the exact opposite of the truth. With a stable name the state is
          carried by `aria-pressed` (as §16 requires), and sighted users still get "Mute" /
          "Unmute" from the tooltip, which is a description and may change.
        */}
        <MeetingToolbarButton
          icon={micOn ? Mic : MicOff}
          label="Microphone"
          tooltip={micOn ? 'Mute' : 'Unmute'}
          state={micOn ? 'default' : 'danger'}
          pressed={micOn}
          size="mobile"
          onClick={onToggleMic}
          className="md:h-12 md:w-12 md:rounded-[14px]"
        />
        <MeetingToolbarButton
          icon={cameraOn ? Video : VideoOff}
          label="Camera"
          tooltip={cameraOn ? 'Stop video' : 'Start video'}
          state={cameraOn ? 'default' : 'danger'}
          pressed={cameraOn}
          size="mobile"
          onClick={onToggleCamera}
          className="md:h-12 md:w-12 md:rounded-[14px]"
        />
        {/* ⚠ DESKTOP BAR ONLY — its mobile twin lives in MoreSheet. ⚠ AND ONLY WHERE THE BROWSER
            CAN ACTUALLY SHARE: an absent control reads "this browser doesn't do that", a live one
            that silently fails reads "Balo is broken". */}
        {canShareScreen ? (
          <MeetingToolbarButton
            icon={MonitorUp}
            label="Share screen"
            tooltip={isSharingScreen ? 'Stop sharing' : 'Share screen'}
            state={isSharingScreen ? 'active' : 'default'}
            pressed={isSharingScreen}
            size="desktop"
            onClick={onToggleScreenShare}
            className="hidden md:flex"
          />
        ) : null}
        {/* ⚠ SLOT 3 ON MOBILE IS CHAT (BAL-437). It renders NOTHING today. */}
        <MoreSheet
          open={moreOpen}
          onOpenChange={onMoreOpenChange}
          showLayoutToggle={showLayoutToggle}
          isGallery={isGallery}
          onToggleLayout={onToggleLayout}
          isSharingScreen={isSharingScreen}
          canShareScreen={canShareScreen}
          onToggleScreenShare={onToggleScreenShare}
          onOpenSettings={onOpenSettings}
        />
        <span className="bg-border mx-1 hidden h-8 w-px md:block" aria-hidden="true" />
      </div>

      <LeaveControl
        isOwner={isOwner}
        contextNoun={contextNoun}
        isCase={isCase}
        onLeave={onLeave}
        onEndForEveryone={onEndForEveryone}
        isEnding={isEnding}
      />
    </div>
  );
}
