/**
 * A JSDOM-friendly `motion/react` stub, as ONE definition.
 *
 * ⚠⚠ THE STUBS MUST BE **CACHED PER TAG**. A bare `get` handler returns a NEW `forwardRef`
 * component on every property access, so React sees a different element TYPE on every render
 * and REMOUNTS the entire subtree. That is not a harmless inefficiency in a test: a remount
 * re-fires `autoFocus`, so `userEvent.type` scatters characters across fields (the first
 * keystroke lands in the field you clicked, the rest land wherever `autoFocus` jumped) and the
 * failure reads like a component bug rather than a mock bug. Memoising is what makes this a
 * stub instead of a remount generator.
 *
 * ⚠ `whileTap` IS IN THE FILTERED SET. `apps/web` runs ESLint with `--max-warnings 0` and React
 * warns about unknown DOM attributes, so leaking a motion-only prop onto a real `<button>` is
 * console noise that eventually hides a real warning.
 *
 * ⚠ IT IS NOT A `*.test.ts` FILE and is not named like one — vitest collects only
 * `*.test.ts` / `*.spec.ts`, so this is imported, never run as a suite. Consumers wire it as:
 *
 *     vi.mock('motion/react', async () => {
 *       const { createMotionStub } = await import('@/test/motion-stub');
 *       return createMotionStub();
 *     });
 *
 * ── ⚠⚠ `animatePresenceMode: 'wait'` — WHY A SECOND MODE EXISTS AT ALL ───────────────────
 *
 * The default `AnimatePresence` stub is `({ children }) => children`, which mounts the
 * incoming child in the SAME commit as the state change. Real `AnimatePresence mode="wait"`
 * does the opposite: it holds the OUTGOING child mounted for the length of its exit and does
 * not mount the incoming one until that finishes. Any focus-management code that reads a ref
 * in a `useEffect([state])` therefore sees the ref still pointing at the element that is about
 * to unmount — focus lands on a dying node and falls to `<body>` — while the passthrough stub
 * makes it look correct. That exact defect shipped and passed its test.
 *
 * So `'wait'` renders the PREVIOUS child for one extra commit and swaps in an effect. It is
 * opt-in rather than the default because it changes commit counts for every consumer, and the
 * ordering only matters to the surfaces that move focus across a transition.
 */
import {
  createElement,
  forwardRef,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
  type Ref,
} from 'react';

/** Props `motion` consumes itself and that must never reach the DOM. */
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'variants',
  'transition',
  'whileTap',
  'whileHover',
  'layout',
  'layoutId',
]);

/** The `key` of a single keyed child, or `null` for anything else. */
function childKey(children: ReactNode): string | null {
  return isValidElement(children) ? String(children.key) : null;
}

/**
 * ⚠ THE `mode="wait"` SIMULATION. Renders the OUTGOING child for one extra commit whenever the
 * keyed child changes, then swaps — so the incoming child is NOT mounted at the commit where
 * the consumer's state changed. That is the ordering real `AnimatePresence mode="wait"`
 * produces, and the only one under which a focus bug on a replaced card is visible.
 */
function WaitingAnimatePresence({ children }: { children: ReactNode }): ReactNode {
  const [shown, setShown] = useState<ReactNode>(children);
  const incomingKey = childKey(children);
  const shownKey = childKey(shown);

  useEffect(() => {
    // One commit later — this stands in for the exit animation completing.
    if (incomingKey !== shownKey) setShown(children);
  }, [children, incomingKey, shownKey]);

  return incomingKey === shownKey ? children : shown;
}

export interface MotionStubOptions {
  /**
   * `'passthrough'` (default) mounts the incoming child immediately.
   * `'wait'` reproduces `AnimatePresence mode="wait"`'s hold — see the module docblock.
   */
  readonly animatePresenceMode?: 'passthrough' | 'wait';
}

export function createMotionStub(options: MotionStubOptions = {}): Record<string, unknown> {
  const cache = new Map<string, unknown>();

  return {
    useReducedMotion: () => false,
    AnimatePresence:
      options.animatePresenceMode === 'wait'
        ? WaitingAnimatePresence
        : ({ children }: { children: ReactNode }) => children,
    motion: new Proxy(
      {},
      {
        get: (_target: unknown, prop: string) => {
          const cached = cache.get(prop);
          if (cached !== undefined) return cached;

          const Stub = forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return createElement(prop, { ...filtered, ref });
          });

          cache.set(prop, Stub);
          return Stub;
        },
      }
    ),
  };
}
