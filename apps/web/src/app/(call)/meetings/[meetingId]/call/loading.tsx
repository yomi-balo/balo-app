/**
 * BAL-435 — the call route's LOADING state: the frame's chrome, drawn. Never a spinner on blank.
 *
 * ⚠ IT FOLLOWS `(dashboard)/meetings/[meetingId]/loading.tsx` EXACTLY: an `<output>` wrapper (not
 * `role="status"` — SonarCloud S6819 flags the ARIA role where a native element exists),
 * `<span>` children ONLY (an `<output>` is phrasing content, so a `<div>` inside it is invalid
 * markup), an `sr-only` "Loading…", and **keys from a fixed literal array, never an array index**
 * (S6479).
 *
 * ⚠⚠ IT CARRIES `dark` — THE FRAME'S PALETTE, NOT THE VIEWER'S. The skeleton is supposed to be
 * the frame's bones, and the frame is permanently dark (§6). Drawn in a light-mode viewer's own
 * theme it was a white top bar, white toolbar circles and a white stage well that flipped to a
 * dark call a beat later, so the real frame's arrival read as a flash rather than a resolve.
 * ⚠ SEMANTIC TOKENS ONLY BELOW: `dark:`-prefixed utilities do NOT match the element that CARRIES
 * `.dark` (the variant is `&:is(.dark *)`, a descendant selector).
 */

/** ⚠ FIXED LITERALS — never an index, and never a value interpolated from one. */
const TOOLBAR_KEYS = ['mic', 'camera', 'share', 'more', 'leave'] as const;

export default function CallLoading(): React.JSX.Element {
  return (
    <output
      aria-label="Loading the call"
      className="dark bg-background flex h-full w-full flex-col overflow-hidden"
    >
      <span className="border-border flex h-13 shrink-0 items-center justify-between border-b px-4">
        <span className="bg-muted/40 block h-3 w-40 animate-pulse rounded" />
        <span className="bg-muted/40 block h-3 w-16 animate-pulse rounded" />
      </span>

      <span className="block min-h-0 flex-1 p-3">
        <span className="bg-muted/40 block h-full w-full animate-pulse rounded-2xl" />
      </span>

      <span className="border-border flex h-[88px] shrink-0 items-center justify-center gap-2.5 border-t px-4 md:h-24">
        {TOOLBAR_KEYS.map((key) => (
          <span
            key={key}
            className="bg-muted/40 block h-[46px] w-[46px] animate-pulse rounded-full"
          />
        ))}
      </span>

      <span className="sr-only">Loading…</span>
    </output>
  );
}
