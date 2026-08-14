/**
 * BAL-435 — THE THREE BREAKPOINTS THE CALL FRAME USES, NAMED SO THEY CANNOT DRIFT FROM THE
 * TAILWIND PREFIXES THEY MIRROR.
 *
 * ⚠⚠ `useIsMobile(breakpoint = 1024)` DEFAULTS TO A **TABLET** SPLIT. Accepting that silently
 * for the toolbar would put a phone toolbar on a 900px tablet — so every JS consumer in this
 * feature passes one of the constants below explicitly.
 *
 * ⚠ VISIBILITY IS DONE IN **CSS**, NOT IN JS. `useIsMobile` renders `false` on the first paint
 * (its `matchMedia` read happens in an effect), so a JS-gated toolbar flashes the desktop ladder
 * on every mobile join. JS is used ONLY where BEHAVIOUR differs — a Sheet vs a Popover, a drag
 * vs a tap — and in each of those the component does not render until an interaction well after
 * the effect has run, so the SSR-safe `false` is harmless.
 */

/**
 * The toolbar ladder's split — Tailwind `md`. The design states the mobile ladder holds "320px
 * to 767px", so bar-only controls carry `hidden md:inline-flex` and their MoreSheet twins carry
 * `md:hidden`.
 */
export const MEETING_TOOLBAR_MOBILE_MAX_PX = 768;

/**
 * ⚠ WHY THERE IS NO `MEETING_VIEW_CONTROLS_MIN_PX` CONSTANT HERE, STATED SO NOBODY RE-ADDS ONE:
 * ViewControls' `lg` split is done ENTIRELY in CSS (`hidden lg:flex` on the stage overlay,
 * `lg:hidden` on its MoreSheet twin), and JS is used only for the fullscreen CAPABILITY probe,
 * which is a feature test rather than a width test. A constant with no consumer is dead code —
 * and worse than dead, because it implies a JS breakpoint that would flash the wrong controls on
 * first paint.
 */
