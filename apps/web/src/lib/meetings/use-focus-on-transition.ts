'use client';

import { useCallback, useRef } from 'react';

/**
 * BAL-132 — MOVE FOCUS TO THE HEADING OF THE CARD THAT JUST ARRIVED, AS ONE POLICY BOTH JOIN
 * SURFACES SHARE.
 *
 * Every state change on `/join/m/[meetingId]` and `/join/[token]` REPLACES the entire card.
 * That drops focus to `<body>`, so a keyboard or screen-reader user is silently returned to
 * the top of the document with no signal that anything happened — after submitting a form,
 * after being admitted, after a link turns out to be dead.
 *
 * ── ⚠⚠ WHY THIS IS A CALLBACK REF AND NOT A `useEffect` READING `ref.current` ────────────
 *
 * The obvious version — `const ref = useRef(); useEffect(() => ref.current?.focus(), [state])`
 * — **IS A NO-OP IN A REAL BROWSER HERE**, and it shipped and passed its test.
 *
 * Both cards are wrapped in `<AnimatePresence mode="wait">`. `mode="wait"` holds the OUTGOING
 * child mounted for the length of its exit (0.18s) and does not mount the incoming one until
 * that finishes. So at the commit where `state` changes — which is exactly when a
 * `useEffect([state])` runs — `ref.current` still points at the heading that is ABOUT TO
 * UNMOUNT. The effect focuses a dying node; focus then falls to `<body>`; and nothing re-fires
 * when the replacement finally mounts. The test passed only because the JSDOM motion stub
 * rendered `AnimatePresence` as `({ children }) => children`, mounting the incoming child in
 * the same commit and hiding the entire problem.
 *
 * A callback ref inverts the dependency: instead of asking "which heading exists now?" at a
 * moment we cannot control, it ARMS an intent on the state change and DISCHARGES it whenever
 * the next heading mounts — however many frames later that is. It is correct under both
 * orderings, which is why it needs no knowledge of the animation at all.
 *
 * ── ⚠⚠ AND THE ARMING HAPPENS **DURING RENDER**, NOT IN AN EFFECT ────────────────────────
 *
 * This is the second half of the same ordering problem and it is easy to get wrong in the
 * opposite direction. React attaches refs BEFORE it runs passive effects, so an effect that
 * armed the intent would be too late in the case where the incoming heading mounts in the SAME
 * commit as the state change (no exit animation, `prefers-reduced-motion`, or the passthrough
 * test stub): the ref callback would fire with the intent still unarmed, consume nothing, and
 * the effect would arm a flag that nothing subsequently mounts to discharge. Focus would land
 * nowhere — the same end result as the effect-based bug, reached from the other side.
 *
 * Comparing against a ref DURING RENDER is armed before either ordering can observe it. It is
 * the standard `usePrevious`-style render-phase comparison and it is idempotent: a re-render
 * with an unchanged `state` is a no-op, so a double-invoked render (StrictMode) cannot
 * double-arm or disarm.
 *
 * ⚠ THE FIRST MOUNT IS SKIPPED — `null` is the "nothing has rendered yet" sentinel, which is
 * why the parameter is `string` and not `string | null`. Stealing focus on first paint is
 * hostile: the visitor has not done anything yet, and on the lobby it would fight the form's
 * own `autoFocus`.
 *
 * ⚠ ARMED-BUT-UNDISCHARGED IS SAFE. If a state transitions twice before any heading mounts,
 * the intent simply survives to the last one — which is the heading the user ends up looking
 * at. If a state renders no heading at all, the intent stays armed and the NEXT one takes it;
 * that is strictly better than focusing nothing.
 *
 * ⚠ `tabIndex={-1}` ON THE HEADING IS THE OTHER HALF and lives at each call site: it is what
 * makes a non-interactive element focusable programmatically without joining the tab order.
 *
 * `apps/web/src/app/join/focus-on-transition.test.tsx` drives BOTH surfaces through the
 * `mode="wait"` stub, so the regression this exists to prevent is reproduced rather than
 * assumed.
 */
export function useFocusOnTransition(state: string): React.RefCallback<HTMLHeadingElement> {
  /** `false` until a transition arms it; consumed by the next heading that mounts. */
  const pendingRef = useRef(false);
  /** The last rendered state. `null` ⇒ nothing has rendered yet, so this is the first paint. */
  const lastStateRef = useRef<string | null>(null);

  // ⚠ RENDER-PHASE, DELIBERATELY — see the docblock. Idempotent for an unchanged `state`.
  if (lastStateRef.current !== state) {
    const isFirstRender = lastStateRef.current === null;
    lastStateRef.current = state;
    if (!isFirstRender) pendingRef.current = true;
  }

  return useCallback((node: HTMLHeadingElement | null): void => {
    // ⚠ A DETACH (`null`) IS THE OUTGOING CARD LEAVING — it must not consume the intent.
    if (node === null || !pendingRef.current) return;
    pendingRef.current = false;
    node.focus();
  }, []);
}
