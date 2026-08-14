/**
 * BAL-389 — the ONE centred box every end-of-call route state renders into.
 *
 * ⚠⚠ IT EXISTS SO THE FOUR STATES CANNOT DRIFT. `loading.tsx`, `error.tsx`, `not-found.tsx` and
 * `EndOfCallLayout` each used to own a copy of the outer wrapper, and two of them had already
 * diverged: the loaded card and the skeleton were vertically centred inside `min-h-[70vh]` while
 * a failed load snapped to a top-aligned `py-12` block. On a route whose whole job is one small
 * card in the middle of the viewport that reads as a layout bug, not a state change. One
 * component, imported by all four — the only way the values stay in lockstep.
 *
 * ⚠⚠ `min-h-[70vh]`, NOT `min-h-full`, AND THE DIFFERENCE IS VISIBLE. This route renders inside
 * the `(dashboard)` layout, whose wrapper is `<main class="flex-1 p-6 lg:p-8"><div
 * class="mx-auto max-w-7xl">` — `height: auto`. A percentage `min-height` against an indefinite
 * parent height resolves to nothing, so `min-h-full` centred nothing at all.
 *
 * ⚠⚠ A FLAT MUTED BACKGROUND, NEVER A GRADIENT — AND THIS IS THE DESIGN REFERENCE, NOT A
 * SIMPLIFICATION. `.claude/design-references/end-of-call.jsx` paints a FLAT `C.bg` (`#EEF0F3`)
 * behind the card and lets the card's own border and shadow carry the depth. The gradient wash
 * this replaced was a child of the dashboard's `max-w-7xl` inside `main.p-6`, so it was inset on
 * all four sides and terminated in a visible seam — a tinted rectangle floating on the page
 * rather than atmosphere. balo-ui asks for depth, and depth here comes from the card.
 *
 * ⚠ IT OWNS THE WIDTH TOO (`max-w-[440px]`), so the skeleton, the card, the error boundary and
 * the not-found page are all exactly the same width and nothing re-flows between them.
 */
export function EndOfCallShell({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="bg-muted/30 flex min-h-[70vh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-[440px]">{children}</div>
    </div>
  );
}
