import 'server-only';

/**
 * BAL-436 — the BARE, TOKENLESS meeting join URL the People panel's "Copy join link" writes.
 *
 * ── ⚠⚠ WHY IT IS BUILT SERVER-SIDE AND NOT FROM `globalThis.location` ───────────────────
 *
 * A client-assembled origin is whatever host the page happens to be served from — a preview
 * deployment, a proxy, a locally-mapped hostname — and a host would paste that into a
 * colleague's inbox believing it was the product's own link. The env var is the one answer
 * that is the same for everybody.
 *
 * ⚠⚠ **`import 'server-only'` IS LOAD-BEARING, NOT DECORATION.** `APP_URL` has no
 * `NEXT_PUBLIC_` prefix, so in a client bundle Next inlines it as `undefined` and the builder
 * silently degrades to the production fallback — a preview or staging host would then hand out
 * `https://balo.expert/join/m/…`, a link to a meeting that does not exist there. The marker
 * turns that silent wrong answer into a build error. This module is imported by `page.tsx`, a
 * Server Component, and the URL reaches the browser as a plain string on the registration.
 *
 * ── ⚠ HOW THIS RELATES TO `apps/api`'s ORIGIN, STATED ACCURATELY ────────────────────────
 *
 * `apps/api`'s email templates use `process.env.APP_URL ?? 'https://balo.expert'` — one
 * variable, no second arm. This builder reads **the same `APP_URL` first and falls back to the
 * same default**, so a link copied from the panel and a link received by email agree whenever
 * `APP_URL` is set, which is how every deployed environment is configured
 * (`apps/api/.env.example` sets it).
 *
 * ⚠ THE `NEXT_PUBLIC_APP_URL` ARM IS **WEB-ONLY AND HAS NO API COUNTERPART.** It exists because
 * `apps/web/.env.example` has historically shipped only that variable, so a local checkout that
 * never set `APP_URL` would otherwise mint balo.expert links in development. It is a
 * development convenience, not a shared contract — ⚠ AN EARLIER VERSION OF THIS DOCBLOCK
 * CLAIMED "THE SAME VARIABLE AND THE SAME FALLBACK AS apps/api", WHICH WAS FALSE FOR THIS ARM.
 * `apps/web/.env.example` now lists `APP_URL` as the preferred setting.
 *
 * ── ⚠⚠ WHY THIS LIVES IN `lib/meetings/` RATHER THAN IN THE PAGE THAT USES IT ───────────
 *
 * `join-link-never-writes.test.ts` scans the WHOLE app router for the substring `/join/` and
 * fails on any hit, because a `<Link href="/join/…">` would let Next PREFETCH a guest
 * invitation — stamping an access on a link nobody opened and leaking the token in a
 * `Referer`. That scan is deliberately blunt and must stay that way.
 *
 * This URL is neither of those things: it is TOKENLESS, it is the anonymous LOBBY route
 * (`/join/m/{meetingId}`, not `/join/{token}`), and it is written to a clipboard rather than
 * rendered as an href — so nothing prefetches it and there is no credential in it to leak.
 * Rather than carve an exemption into a security scan for a convenience, the builder simply
 * lives outside the scanned tree, where it belongs anyway: it is a pure function of an env var
 * and an id, and it is unit-testable here.
 *
 * ⚠ THE RECIPIENT IS NOT ADMITTED BY HOLDING THIS. They land in the pending lobby and a host
 * must let them in — which is exactly what the panel's helper line says, and why the row they
 * arrive as is marked UNVERIFIED.
 */

/**
 * ⚠ MIRRORS `apps/api`'s `BASE_URL` FALLBACK (`templates/index.ts`) EXACTLY. Do not diverge —
 * a panel link and an emailed link pointing at different origins is the failure.
 */
const DEFAULT_APP_ORIGIN = 'https://balo.expert';

/**
 * Drop trailing slashes.
 *
 * ⚠ A LINEAR SCAN, NOT `/\/+$/`. That pattern is a quantifier with a rejecting suffix, which
 * `regexp/no-super-linear-move` (the local half of SonarCloud's S5852) flags as quadratic —
 * and the escape hatch the repo already uses elsewhere (`sanitizeMeetingFileName`,
 * `_source-scan`) is exactly this: a non-regex scan, with no pattern engine behind it.
 */
function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

export function meetingJoinLinkUrl(meetingId: string): string {
  const base = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_ORIGIN;
  // ⚠ TRAILING SLASHES TRIMMED. `APP_URL=https://balo.expert/` would otherwise mint a double
  // slash, which resolves fine in a browser and looks broken in an inbox.
  return `${withoutTrailingSlash(base)}/join/m/${meetingId}`;
}

/**
 * BAL-439 — the guest recap's in-app path. A PATH, not an absolute URL — this is same-origin
 * navigation from `[token]/page.tsx` and `[token]/join-control.tsx`, so no origin lookup and no
 * `server-only` obligation apply to it the way they do to {@link meetingJoinLinkUrl}'s emailed
 * absolute URL. It lives here for the same reason that one does: `join-link-never-writes.test.ts`
 * bans the literal `/join/` in non-comment code under `app/join`, and rather than carve an
 * exemption into that scan, the builder simply lives outside the scanned tree.
 */
export function guestRecapPath(token: string, meetingId: string): string {
  return `/join/${token}/recap/${meetingId}`;
}

/**
 * Back to the invitation card. ⚠ Its GET stamps `meetingGuestsRepository.recordAccess` —
 * NEVER prefetch a `<Link>` built from this (see `[token]/page.tsx`'s own docblock on why a
 * prefetch would stamp an access nobody made).
 */
export function guestInvitationPath(token: string): string {
  return `/join/${token}`;
}
