/**
 * BAL-435 — is this pathname the full-bleed in-call surface?
 *
 * ⚠⚠ IT EXISTS SO `AppFooter` CAN RETURN `null` THERE, AND THAT IS NOT COSMETIC.
 * `app/layout.tsx` renders `<AppFooter />` after `{children}` on EVERY route in the app, and on
 * `/meetings/{id}/call` that breaks the surface three ways at once:
 *
 *   1. ~40px of footer sits BELOW an `h-dvh` frame, so a shell that must not scroll, scrolls.
 *   2. It is OUTSIDE the `(call)` layout's `.dark` subtree, so it renders light-mode tokens
 *      under a permanently dark call.
 *   3. On mobile it lands under the toolbar's `env(safe-area-inset-bottom)` padding — a build
 *      version string beneath the Leave button.
 *
 * ⚠ A NAMED, UNIT-TESTED PREDICATE RATHER THAN AN INLINE MAGIC STRING in a shared component. It
 * is a pure string function so it needs no router, no DOM and no mount to test.
 *
 * ⚠ NO REGEX. A segment walk is linear and carries no S5852 exposure.
 */
export function isMeetingCallPath(pathname: string): boolean {
  // '' | 'meetings' | '{id}' | 'call'  — a leading slash yields an empty first segment.
  const segments = pathname.split('?')[0]?.split('#')[0]?.split('/') ?? [];
  if (segments.length !== 4) return false;
  const [empty, meetings, meetingId, call] = segments;
  return empty === '' && meetings === 'meetings' && call === 'call' && (meetingId ?? '').length > 0;
}
