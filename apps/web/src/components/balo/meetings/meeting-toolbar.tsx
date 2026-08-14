'use client';

import { Mic, MicOff, MonitorUp, Paperclip, Users, Video, VideoOff } from 'lucide-react';
import type { MeetingPanelId } from '@/lib/meetings/meeting-panels';
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
  /**
   * BAL-436 — which side panel is open, or `null`.
   *
   * ⚠ `undefined` (rather than `null`) MEANS **THE SLOT IS NOT REGISTERED AT ALL** — no
   * People button, no Files button, no More-sheet rows. Both GUEST mounts land here
   * structurally, because neither mounts the route context that carries the registration.
   * Absent, never disabled.
   */
  readonly openPanel?: MeetingPanelId | null;
  /** ⚠ Supplied IFF `openPanel` is. Toggling: re-clicking the open panel's button closes it. */
  readonly onTogglePanel?: (id: MeetingPanelId) => void;
  /** Focused when a panel closes, so focus returns to the control that opened it. */
  readonly peopleButtonRef?: React.Ref<HTMLButtonElement>;
  readonly filesButtonRef?: React.Ref<HTMLButtonElement>;
  /**
   * BAL-134 / ADR-1049 — ⚠⚠ THE SERVER'S END-AUTHORITY VERDICT (`isOwner || clientPrincipal`)
   * — the only input to the end-for-everyone branch. **NOT `isOwner`**, which mints the Daily
   * owner token and would deny the paying client the ability to stop their own spend.
   */
  readonly canEndMeeting: boolean;
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
  openPanel,
  onTogglePanel,
  peopleButtonRef,
  filesButtonRef,
  canEndMeeting,
  contextNoun,
  isCase,
  onLeave,
  onEndForEveryone,
  isEnding,
}: Readonly<MeetingToolbarProps>): React.JSX.Element {
  // ⚠ THE SLOT REGISTRATION, READ ONCE. `onTogglePanel === undefined` ⇒ absent everywhere:
  // no bar buttons, no MoreSheet rows. Hoisted so the two readers cannot drift.
  const panelSlot = onTogglePanel === undefined ? {} : { onTogglePanel };

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
        {/* ⚠⚠ BAL-436 — see `PanelSlotButtons`. Absent entirely when the slot is unregistered. */}
        {onTogglePanel === undefined ? null : (
          <PanelSlotButtons
            openPanel={openPanel ?? null}
            onTogglePanel={onTogglePanel}
            peopleButtonRef={peopleButtonRef}
            filesButtonRef={filesButtonRef}
          />
        )}
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
          {...panelSlot}
        />
        <span className="bg-border mx-1 hidden h-8 w-px md:block" aria-hidden="true" />
      </div>

      <LeaveControl
        canEndMeeting={canEndMeeting}
        contextNoun={contextNoun}
        isCase={isCase}
        onLeave={onLeave}
        onEndForEveryone={onEndForEveryone}
        isEnding={isEnding}
      />
    </div>
  );
}

/**
 * BAL-436 — the desktop People and Files pair.
 *
 * ⚠⚠ **DESKTOP ONLY (`hidden lg:flex`), AND SLOT 3 ON MOBILE STAYS CHAT'S AND STAYS EMPTY.**
 * The mobile ladder (Mic · Camera · Chat · More · Leave) is a FIXED RULE, not a responsive
 * accident — see the file docblock. People and Files reach a phone through `MoreSheet`,
 * exactly as Share screen does.
 *
 * ⚠⚠ **`lg`, NOT `md` — AND ALL THREE READERS MUST AGREE.** The panel overlays below `lg`
 * (`meeting-side-panel.tsx`), so these buttons and `MoreSheet`'s People/Files rows are `lg`
 * too. When these were `md` and the panel was `lg`, the 768–1023px band showed the DESKTOP
 * buttons, hid the MoreSheet rows, and opened a full-width overlay — i.e. the one width where
 * every reader disagreed. ⚠ Share screen above stays `md` deliberately: it has no panel and
 * its own MoreSheet twin is `md:hidden`, so that pair agrees with itself.
 *
 * ⚠ `pressed` CARRIES THE STATE while the accessible NAME stays stable ("People", not "Hide
 * people"), for the reason `MeetingToolbarButton.label` records: a name that changes beside a
 * flipping `aria-pressed` announces the opposite of the truth. The changing wording lives in
 * the tooltip, which is a description.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY — inline, `MeetingToolbar`'s own body scored
 * 22 against SonarCloud's allowed 15. The repo's precedent is to EXTRACT, never to disable the
 * rule (`FrameStage` was split out of `MeetingFrameInner` for exactly this). The markup is
 * unchanged, line for line.
 */
function PanelSlotButtons({
  openPanel,
  onTogglePanel,
  peopleButtonRef,
  filesButtonRef,
}: Readonly<{
  openPanel: MeetingPanelId | null;
  onTogglePanel: (id: MeetingPanelId) => void;
  peopleButtonRef?: React.Ref<HTMLButtonElement>;
  filesButtonRef?: React.Ref<HTMLButtonElement>;
}>): React.JSX.Element {
  return (
    <>
      <MeetingToolbarButton
        ref={filesButtonRef}
        icon={Paperclip}
        label="Files"
        tooltip={openPanel === 'files' ? 'Hide files' : 'Files'}
        state={openPanel === 'files' ? 'active' : 'default'}
        pressed={openPanel === 'files'}
        size="desktop"
        onClick={() => onTogglePanel('files')}
        className="hidden lg:flex"
      />
      <MeetingToolbarButton
        ref={peopleButtonRef}
        icon={Users}
        label="People"
        tooltip={openPanel === 'people' ? 'Hide people' : 'People'}
        state={openPanel === 'people' ? 'active' : 'default'}
        pressed={openPanel === 'people'}
        size="desktop"
        onClick={() => onTogglePanel('people')}
        className="hidden lg:flex"
      />
    </>
  );
}
