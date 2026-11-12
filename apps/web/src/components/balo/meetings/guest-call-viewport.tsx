/** The marker the `/join` layout and the root `AppFooter` key their guest-call styles on. */
export const GUEST_CALL_VIEWPORT_ATTRIBUTE = 'data-guest-call-viewport';

interface GuestCallViewportProps {
  readonly children: React.ReactNode;
}

/**
 * The full-viewport frame an admitted guest's call renders in — the guest-side twin of the
 * member `(call)` layout's `h-dvh` shell, so both sides of one call get the same stage.
 *
 * The `/join` layout is a narrow 560px invitation column. Its `<main>` drops that width and its
 * padding while it contains this element (`has-[[data-guest-call-viewport]]:…` in
 * `app/join/layout.tsx`), and the root `AppFooter` hides itself, because a guest's call has no
 * URL of its own for the footer's call-path check to match. Both must spell the attribute
 * literally for Tailwind to emit the variant; their tests pin that they still agree with
 * {@link GUEST_CALL_VIEWPORT_ATTRIBUTE}.
 *
 * `h-dvh`, never `h-screen` — mobile browser chrome makes `100vh` taller than the visible
 * viewport and pushes the call toolbar (and Leave) off-screen.
 */
export function GuestCallViewport({
  children,
}: Readonly<GuestCallViewportProps>): React.JSX.Element {
  return (
    <div {...{ [GUEST_CALL_VIEWPORT_ATTRIBUTE]: '' }} className="h-dvh w-full">
      {children}
    </div>
  );
}
