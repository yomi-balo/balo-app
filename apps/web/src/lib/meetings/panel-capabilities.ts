import type { MeetingPanelRegistration } from './meeting-panels';

/**
 * BAL-445 — WHAT ONE AUDIENCE MAY REACH ON THE CALL FRAME. Pure, no `server-only`, no
 * `@balo/db`, no `@/lib/logging`, no React — this file is scanned by
 * `meeting-call-no-lens-gate.test.ts` and must stay client-safe.
 */
export interface PanelCapabilities {
  readonly hasPeople: boolean;
  readonly hasFiles: boolean;
  readonly hasChat: boolean;
  readonly hasBalance: boolean;
  readonly hasReactions: boolean;
  /** ⚠ Read by the FRAME to pick the panel component, never by a component to hide a control. */
  readonly isGuest: boolean;
}

const NOTHING: PanelCapabilities = {
  hasPeople: false,
  hasFiles: false,
  hasChat: false,
  hasBalance: false,
  hasReactions: false,
  isGuest: false,
};

/**
 * ⚠⚠ THE ONE PLACE "WHAT MAY THIS AUDIENCE REACH" IS DECIDED. Four surfaces ask it (toolbar,
 * More sheet, seat chip, panel switch); asking it four times inline is what pushed
 * `resolvePanelSlots` into existence in the first place, and a guest arm inlined at each call
 * site would push `meeting-frame-impl.tsx` back over the cognitive-complexity ceiling.
 *
 * ⚠ THERE IS NO LENS, ROLE, MODE OR CAPABILITY TOKEN ANYWHERE IN HERE, and there must not be:
 * `meeting-call-no-lens-gate.test.ts` bans the substrings `lens`, `activeMode`, `platformRole`
 * and `role ===` in this directory. The only input is the registration the ROUTE mounted.
 */
export function resolvePanelCapabilities(
  panels: MeetingPanelRegistration | null
): PanelCapabilities {
  if (panels === null) {
    return NOTHING;
  }

  if (panels.audience === 'guest') {
    return {
      hasPeople: false,
      hasFiles: true,
      hasChat: panels.chat !== null,
      hasBalance: false,
      hasReactions: false,
      isGuest: true,
    };
  }

  return {
    hasPeople: true,
    hasFiles: true,
    hasChat: panels.chat !== null,
    hasBalance: panels.balance !== null,
    hasReactions: panels.realtime !== null,
    isGuest: false,
  };
}
