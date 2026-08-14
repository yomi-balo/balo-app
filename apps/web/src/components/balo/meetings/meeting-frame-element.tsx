'use client';

import { createContext, useContext } from 'react';

/**
 * BAL-435 — THE FRAME ELEMENT, SHARED, SO EVERY OVERLAY PORTALS **INSIDE** IT.
 *
 * ⚠⚠ THIS IS A CORRECTNESS BUG IF IGNORED, NOT A COSMETIC ONE. Radix `Dialog`, `AlertDialog`,
 * `Popover`, `Tooltip` and `DropdownMenu` all portal to `document.body` by default, and that
 * fails twice on this surface:
 *
 *   1. **Light chrome over a dark call.** Portal content escapes the frame's `.dark` subtree and
 *      resolves light-mode variables.
 *   2. ⚠⚠ **IN FULLSCREEN, PORTAL CONTENT IS INVISIBLE.** When the frame is the fullscreen
 *      element the browser renders ONLY that element's subtree, so a Sheet portaled to `<body>`
 *      is outside it — the More sheet, the device settings AND the end-for-everyone confirm
 *      dialog simply do not appear. That is a destructive-confirm dialog vanishing.
 *
 * Passing `container={frameElement}` fixes both; `className="dark"` on the portal fixes only the
 * first. `more-sheet.test.tsx` and `device-settings-sheet.test.tsx` pin the descendant relation.
 *
 * ⚠ IT IS AN **ELEMENT IN STATE**, NOT A `useRef`. A ref's `.current` does not re-render the
 * consumers that need it as a portal target, so the first overlay opened after mount would get
 * `null` and silently fall back to `<body>` — the exact failure this exists to prevent.
 */

const MeetingFrameElementContext = createContext<HTMLElement | null>(null);

/**
 * The element every overlay in this subtree portals into.
 *
 * ⚠ `null` IS A LEGITIMATE ANSWER (before the frame has mounted, and in a component test that
 * renders a control in isolation). Radix treats a `null` container as "use the default", so the
 * overlay still works — it is only the two guarantees above that are unavailable.
 */
export function useMeetingFrameElement(): HTMLElement | null {
  return useContext(MeetingFrameElementContext);
}

export function MeetingFrameElementProvider({
  element,
  children,
}: Readonly<{ element: HTMLElement | null; children: React.ReactNode }>): React.JSX.Element {
  return (
    <MeetingFrameElementContext.Provider value={element}>
      {children}
    </MeetingFrameElementContext.Provider>
  );
}
