'use client';

import { forwardRef } from 'react';
import {
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Paperclip,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
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
 * ⚠ BAL-437 FILLED SLOT 3, with no layout change — the order was already encoded.
 *
 * ⚠⚠ THE CHAT BUTTON CARRIES **NO BREAKPOINT CLASS**, unlike People / Files / Share screen. It
 * is the one control the mobile ladder names AND the one every desktop call wants in reach, so
 * it is a single always-visible button rather than a bar/MoreSheet pair. That is exactly why
 * `MoreSheet` has no Chat row: a row plus an always-visible twin is two live controls for one
 * slot, doubling the tab order and what a screen-reader user hears.
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
   * BAL-437 — ⚠ FORWARDED STRAIGHT TO `MoreSheet`'s TRIGGER, read by nothing here. The frame
   * holds it because `ReactionPicker` (which the frame builds) must focus the More button when
   * the MOBILE picker closes — its own trigger is `display: none` at that width. See
   * `more-sheet.tsx`'s `triggerRef` doc.
   */
  readonly moreButtonRef?: React.Ref<HTMLButtonElement>;
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
  readonly chatButtonRef?: React.Ref<HTMLButtonElement>;
  /**
   * BAL-437 — ⚠ WHETHER THE **CHAT** SLOT IS REGISTERED, which is NARROWER than
   * `onTogglePanel !== undefined`. A meeting can have People and Files and no conversation
   * anchor at all (an `admin` call, a `project_discovery`, an ambiguous or unprovisioned
   * context) — those calls get no Chat control, not a disabled one.
   */
  readonly hasChat?: boolean;
  /**
   * BAL-437 — ⚠⚠ A **DOT, NOT A COUNT.** A count implies a read-state model this ticket does
   * not build (there is no per-message watermark on this surface). It is set when a message
   * arrives while the panel is closed, cleared when the panel opens, and never persists across
   * a page load. ⚠ IT IS NOT ANNOUNCED through the §16 live region: a per-message announcement
   * during a live call is noise, and that region is for mutation outcomes.
   */
  readonly unreadChat?: boolean;
  /**
   * BAL-437 — the desktop Reactions control, BUILT BY THE FRAME (which owns the picker's open
   * state and the floater layer) and slotted in here. ⚠ `undefined` ⇒ REALTIME IS UNCONFIGURED
   * and the slot is ABSENT — never a disabled emoji button.
   *
   * ⚠ IT ARRIVES AS A NODE RATHER THAN AS PROPS because the picker is a controlled overlay
   * whose open state must survive the toolbar re-rendering, and because the floater layer it
   * feeds lives over the STAGE, not in the bar.
   */
  readonly reactionControl?: React.ReactNode;
  /** BAL-437 — opens the picker from `MoreSheet`'s `md:hidden` row. Same registration signal. */
  readonly onOpenReactions?: () => void;
  /**
   * BAL-134 / ADR-1049 — ⚠⚠ THE SERVER'S END-AUTHORITY VERDICT (`isOwner || clientPrincipal`),
   * the only input to the end-for-everyone branch.
   *
   * ⚠ THIS REPLACED `isOwner` HERE, AND THE TWO MUST NOT BE RE-MERGED. `isOwner` is the
   * `host_meetings` verdict AND the sole input to the Daily `is_owner` token property, so
   * gating End on it would both deny the paying client the ability to stop their own spend and
   * — if widened to admit them — mint Daily owner tokens for clients. `meeting-call-no-lens-gate`
   * pins `isOwner` out of this file for exactly that reason.
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
  moreButtonRef,
  openPanel,
  onTogglePanel,
  peopleButtonRef,
  filesButtonRef,
  chatButtonRef,
  hasChat = false,
  unreadChat = false,
  reactionControl,
  onOpenReactions,
  canEndMeeting,
  contextNoun,
  isCase,
  onLeave,
  onEndForEveryone,
  isEnding,
}: Readonly<MeetingToolbarProps>): React.JSX.Element {
  // ⚠ THE THREE REGISTRATIONS, RESOLVED ONCE, IN A PURE HELPER. See `resolveToolbarSlots`.
  const { panelSlot, reactionSlot } = resolveToolbarSlots({ onTogglePanel, onOpenReactions });

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
        {/* ⚠ BAL-437 — the desktop Reactions control, built by the frame. `hidden md:flex` is
            carried by the picker itself, mirroring Share screen above. Absent when realtime is
            unconfigured. */}
        {reactionControl}
        {/* ⚠⚠ BAL-436 — see `PanelSlotButtons`. Absent entirely when the slot is unregistered. */}
        {onTogglePanel === undefined ? null : (
          <PanelSlotButtons
            openPanel={openPanel ?? null}
            onTogglePanel={onTogglePanel}
            peopleButtonRef={peopleButtonRef}
            filesButtonRef={filesButtonRef}
          />
        )}
        {/* ⚠⚠ BAL-437 — SLOT 3 ON MOBILE, AND VISIBLE AT EVERY WIDTH. See the file docblock for
            why this one control carries no breakpoint class and has no MoreSheet twin. */}
        <ChatSlot
          ref={chatButtonRef}
          hasChat={hasChat}
          isOpen={openPanel === 'chat'}
          unread={unreadChat}
          onTogglePanel={onTogglePanel}
        />
        <MoreSheet
          open={moreOpen}
          onOpenChange={onMoreOpenChange}
          triggerRef={moreButtonRef}
          showLayoutToggle={showLayoutToggle}
          isGallery={isGallery}
          onToggleLayout={onToggleLayout}
          isSharingScreen={isSharingScreen}
          canShareScreen={canShareScreen}
          onToggleScreenShare={onToggleScreenShare}
          onOpenSettings={onOpenSettings}
          {...panelSlot}
          {...reactionSlot}
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
 * The three independent slot registrations, resolved once.
 *
 * ⚠ A PURE MODULE HELPER RATHER THAN INLINE `const`s, ONLY TO SHED COGNITIVE COMPLEXITY —
 * exactly as `PanelSlotButtons` was extracted, and for exactly the same reason. The logic is
 * unchanged.
 *
 * ⚠ EACH IS SPREAD RATHER THAN PASSED AS AN EXPLICIT `undefined`, so `MoreSheet`'s own
 * "is it registered?" checks stay plain `=== undefined` comparisons.
 */
function resolveToolbarSlots({
  onTogglePanel,
  onOpenReactions,
}: Readonly<{
  onTogglePanel?: (id: MeetingPanelId) => void;
  onOpenReactions?: () => void;
}>): {
  panelSlot: { onTogglePanel?: (id: MeetingPanelId) => void };
  reactionSlot: { onOpenReactions?: () => void };
} {
  return {
    panelSlot: onTogglePanel === undefined ? {} : { onTogglePanel },
    reactionSlot: onOpenReactions === undefined ? {} : { onOpenReactions },
  };
}

/**
 * BAL-437 — the Chat slot, which is ABSENT unless the panel registration AND the chat anchor
 * are both present.
 *
 * ⚠ EXTRACTED SO THE CONDITION LIVES IN ONE PLACE AND OFF `MeetingToolbar`'s own body, which
 * SonarCloud scores at 15. `null` is the slot rule: absent, never disabled.
 */
const ChatSlot = forwardRef<
  HTMLButtonElement,
  Readonly<{
    hasChat: boolean;
    isOpen: boolean;
    unread: boolean;
    onTogglePanel?: (id: MeetingPanelId) => void;
  }>
>(function ChatSlot({ hasChat, isOpen, unread, onTogglePanel }, ref) {
  if (!hasChat || onTogglePanel === undefined) return null;
  return (
    <ChatSlotButton
      ref={ref}
      isOpen={isOpen}
      unread={unread}
      onToggle={() => onTogglePanel('chat')}
    />
  );
});

/**
 * BAL-437 — the Chat control plus its unread dot.
 *
 * ⚠⚠ THE DOT IS A **SIBLING SPAN**, NOT A PROP ON `MeetingToolbarButton`. That primitive is
 * deliberately one `<button>` with one icon and no slots; growing it a badge API for one caller
 * would put a decoration into the control every other surface in this feature uses. The wrapper
 * is `relative` and the dot is `absolute`, so the 46/48px tap target is untouched.
 *
 * ⚠⚠ THE DOT IS **NOT** THE ACCESSIBLE NAME, AND IT IS NOT `aria-hidden` EITHER. A purely
 * visual unread marker is invisible to a screen-reader user, so the state rides the accessible
 * name via a visually-hidden suffix — "Chat, new messages" — which is announced once when the
 * button is reached rather than shouted on every arrival through the §16 live region.
 *
 * ⚠ THE NAME STAYS "Chat" WHILE `aria-pressed` CARRIES OPEN/CLOSED, for the reason
 * `MeetingToolbarButton.label` records: a name that changes beside a flipping `aria-pressed`
 * announces the opposite of the truth. The unread suffix is orthogonal to pressed-ness.
 */
const ChatSlotButton = forwardRef<
  HTMLButtonElement,
  Readonly<{ isOpen: boolean; unread: boolean; onToggle: () => void }>
>(function ChatSlotButton({ isOpen, unread, onToggle }, ref) {
  return (
    <span className="relative inline-flex shrink-0">
      <MeetingToolbarButton
        ref={ref}
        icon={MessageSquare}
        label={unread ? 'Chat, new messages' : 'Chat'}
        tooltip={isOpen ? 'Hide chat' : 'Chat'}
        state={isOpen ? 'active' : 'default'}
        pressed={isOpen}
        size="mobile"
        onClick={onToggle}
        className="md:h-12 md:w-12 md:rounded-[14px]"
      />
      {unread ? (
        <span
          data-testid="chat-unread-dot"
          aria-hidden="true"
          className="bg-primary border-background pointer-events-none absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2"
        />
      ) : null}
    </span>
  );
});

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
