'use client';

import { useCallback, useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * BAL-436 — **THE SINGLE-SLOT SIDE PANEL SHELL.** Header (title · count · close), a scrolling
 * body, an optional sticky footer. One component; People and Files supply the body.
 *
 * ── ⚠⚠ IT IS **NOT A DIALOG**, AT ANY BREAKPOINT. READ THIS BEFORE ADDING A FOCUS TRAP ────
 *
 * At `lg` and above it is an in-flow flex SIBLING of the stage (360px, `shrink-0`). Below `lg`
 * its own classes make it `absolute inset-0` — but **inside the stage row only**
 * (`meeting-frame-impl.tsx`'s `relative flex min-h-0 flex-1`). `MeetingToolbar` renders
 * OUTSIDE and BELOW that row, so on a phone the panel covers the VIDEO and nothing else: Mic,
 * Camera, More and **Leave** stay visible and stay clickable underneath it.
 *
 * ⚠⚠ **AN EARLIER VERSION OF THIS FILE ARMED A FOCUS TRAP AND `aria-modal="true"` AT ≤1023px,
 * JUSTIFIED BY "a keyboard user tabbing past it would land on controls they cannot see". THAT
 * JUSTIFICATION WAS FACTUALLY WRONG ABOUT THIS LAYOUT — they can see them.** What it actually
 * did was lock keyboard and screen-reader users away from Mute and Leave on every phone,
 * tablet and half-screen window, on a LIVE CALL, with Escape as the only undocumented way out.
 * `aria-modal` also hid the frame's §16 live region from AT, since that region is a sibling of
 * this subtree. **Do not reintroduce either.** If a future layout genuinely puts the panel
 * over the toolbar, the fix is to move the toolbar, not to trap focus in front of Leave.
 *
 * ⚠ Tab therefore flows NATURALLY out of the panel and into the toolbar, which is the correct
 * reading order: the panel comes before the controls in the DOM, exactly as it does on screen.
 *
 * ⚠ THE **VISUAL** SPLIT IS PURE CSS (`absolute inset-0` / `lg:relative`), so nothing flashes
 * on first paint and there is no `matchMedia` listener left to get wrong. Removing the
 * conditional role removed the only reason this component read the viewport at all.
 *
 * ⚠ `lg`, NOT `md`. 360px eats a third of a 1024px iPad, and it is the same split
 * `ViewControls`, the toolbar's `PanelSlotButtons` and `MoreSheet`'s People/Files rows all
 * use — all four agree on `lg`, deliberately.
 *
 * ── ⚠ IT IS A LANDMARK REGION, NAMED BY ITS OWN HEADING ─────────────────────────────────
 *
 * A `<section>` with an accessible name is a `region` landmark, so a screen-reader user can
 * jump to it and out of it by landmark — which is what a non-modal side panel should offer
 * instead of a trap. `aria-labelledby` points at the `<h2>`, so the name cannot drift from the
 * visible title.
 *
 * ── ⚠ THE HEADING IS AN `<h2>`, FOCUSED ON OPEN ─────────────────────────────────────────
 *
 * The frame's "exactly one `<h1>` per state" rule is untouched — the panel never emits one.
 * The `<h2>` carries `tabIndex={-1}` and is focused when the panel mounts, so a keyboard or
 * screen-reader user is told what just appeared instead of being left at the toolbar button.
 *
 * ⚠ **NO `aria-busy` ANYWHERE ON THIS SURFACE.** It SUPPRESSES live-region announcements, and
 * `meeting-call-no-lens-gate.test.ts` fails the build over it. Loading states are skeletons
 * and per-row spinners, never a busy flag.
 *
 * ⚠ ESCAPE CLOSES, and returning focus to the button that opened it is the FRAME's job (it
 * holds the ref). Doing it here would mean this component reaching for a node it does not own.
 *
 * ── ⚠⚠ FIX ROUND 1 (W5) — `autoOpened` WITHHOLDS THE MOUNT FOCUS ───────────────────────────
 *
 * The heading-takes-focus rule above is right for a USER-INITIATED open (a click), which is
 * every open this shell has had until BAL-403's auto-open ladder. A background poll deciding to
 * open this panel is not a gesture, and yanking a screen-reader or keyboard user's focus off
 * whatever they were doing mid-call — to read a panel they did not ask for — is worse than the
 * silence it replaces. `autoOpened` (default `false`, so every existing manual-open caller is
 * unaffected) skips the focus move on mount; the CALLER is responsible for saying what happened
 * through the frame's own polite live region instead (see `meeting-frame-impl.tsx`'s `announce`).
 */

/**
 * ⚠ ONE STABLE DOM ID, not a `useId()`. Exactly one panel is mounted at a time (the frame's
 * slot is single-slot by construction), so a generated id would buy nothing and would make the
 * `aria-labelledby` wiring unassertable in a test.
 */
const PANEL_HEADING_ID = 'meeting-side-panel-heading';

export interface MeetingSidePanelProps {
  readonly title: string;
  /** Rendered as a pill beside the title. ⚠ Omitted when unknown — never a zero placeholder. */
  readonly count?: number;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
  /**
   * BAL-403 fix round 1 (W5) — `true` ⇒ this mount was opened by the auto-open ladder, not by a
   * click, so the heading must NOT steal focus. See the module docblock. Default `false`, so
   * People / Files / Chat (every existing caller) keep the shipped focus-on-open behaviour.
   */
  readonly autoOpened?: boolean;
}

export function MeetingSidePanel({
  title,
  count,
  onClose,
  children,
  footer,
  autoOpened = false,
}: Readonly<MeetingSidePanelProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion() === true;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /**
   * ⚠ CAPTURED AT MOUNT, DELIBERATELY. The panel mounts once per open (the frame renders it
   * conditionally, keyed by which panel is open), so `autoOpened` is fixed for this mount's
   * whole life — a later prop change cannot retroactively decide whether THIS mount stole focus.
   */
  const autoOpenedRef = useRef(autoOpened);

  // ⚠ THE HEADING TAKES FOCUS ON OPEN — UNLESS THIS OPEN WAS AUTOMATIC (W5). The panel MOUNTS on
  // open (the frame renders it conditionally), so a mount effect is the whole of the timing —
  // there is no `AnimatePresence mode="wait"` here to defer it past the commit.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    headingRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    },
    [onClose]
  );

  return (
    <motion.section
      data-testid="meeting-side-panel"
      onKeyDown={onKeyDown}
      // ⚠ A NAMED LANDMARK, NEVER `role="dialog"` / `aria-modal`. See the docblock: this panel
      // never covers the toolbar, so claiming modality is a lie a screen reader acts on — and
      // acting on it locked people away from Leave.
      aria-labelledby={PANEL_HEADING_ID}
      className={cn(
        'bg-card border-border flex min-h-0 flex-col overflow-hidden',
        // ⚠ Below `lg`: an overlay over THE STAGE ROW ONLY. The toolbar is outside and below
        // that row, so Mic / Camera / More / Leave stay visible and clickable underneath.
        'absolute inset-0 z-40',
        // At `lg` and above: an in-flow 360px sibling with a single dividing edge.
        'lg:relative lg:inset-auto lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l'
      )}
      // §13.1 — the panel slides in from its own edge. ⚠ Reduced motion collapses it to a fade.
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      // ⚠ AND BACK OUT AGAIN. Without an `exit` the panel vanished in a single frame while it
      // had animated in over 220ms — an asymmetry that reads as a glitch, not a dismissal. The
      // frame wraps this in `AnimatePresence`, which is what makes the property take effect.
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
      transition={{ duration: reduceMotion ? 0.15 : 0.22, ease: 'easeOut' }}
    >
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {/* ⚠ AN `<h2>`, NEVER AN `<h1>` — the frame owns exactly one `<h1>` per state. */}
          <h2
            id={PANEL_HEADING_ID}
            ref={headingRef}
            tabIndex={-1}
            className="text-foreground truncate text-sm font-semibold outline-none"
          >
            {title}
          </h2>
          {count === undefined ? null : (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs tabular-nums">
              {count}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {footer === undefined ? null : (
        <div className="border-border shrink-0 border-t p-3">{footer}</div>
      )}
    </motion.section>
  );
}
