/**
 * BAL-566 fix round 1 (F1, user ruling J1, 2026-09-18) — the AUTHENTICATED MEMBER's in-call route,
 * `/meetings/{meetingId}/call` (BAL-435, `joinAsMemberAction`).
 *
 * ⚠⚠ NOT THE ANONYMOUS GUEST LOBBY (`/join/m/{meetingId}`, built by `meetingJoinLinkUrl` in
 * `join-link.ts`). The ruling that introduced this file found that Join on the dashboard Up next
 * card and the expert Calendar had been sending a signed-in member into the anonymous lobby
 * (name + email, `claimLobbyPlaceAction`, no session read). For a `case` meeting the client-side
 * credit session opens ONLY inside `apps/api`'s `joinMeetingAsMember`
 * (`openCaseSessionBestEffort`, side === 'client') — so a member routed through the lobby instead
 * never opens a metered session, and an expert routed there loses the member/host join entirely.
 *
 * ⚠⚠ BAL-567 MADE THIS THE **ONLY** MEMBER JOIN-PATH BUILDER IN `apps/web`. `memberJoinPath()`
 * (`member-join-path.ts`, `/join/m/{id}`) is DELETED, not aliased: two helpers that both mean
 * "where a signed-in member joins" is the exact duplication the consolidation removes, and an
 * alias would have re-created it under a name whose value no longer matched. Every member-facing
 * producer now emits this route — `book-consultation.ts`, `book-intro-call.ts`, and `apps/api`'s
 * `memberCallUrl()` (the absolute twin, for the ICS facts and the booking calendar projection).
 * `meetingJoinLinkUrl()` stays exactly as it is: it is the People panel's "Copy join link" and
 * guest invitations, anonymous by design (BAL-436), and it is NOT a third definition of this one.
 *
 * ⚠ THE API'S PUBLISH-TIME ZOD REGEX IS THE OTHER HALF OF THIS SHAPE. `memberCallPathSchema`
 * (`apps/api/src/routes/notifications/schema.ts`) pins `/^\/meetings\/[0-9a-f-]{36}\/call$/` on
 * the `joinPath` field of `booking.confirmed` and `conversation.intro_call_booked`. It is enforced
 * at PUBLISH time, not compile time, so a change to the shape here that is not mirrored there
 * fails silently in production rather than in CI.
 *
 * ⚠ PURE, NO `server-only` — DELIBERATELY. Its callers happen to be `server-only` modules that
 * build the path server-side and pass it down as a plain string, and the call page itself
 * (`app/(call)/meetings/[meetingId]/call/page.tsx`) also uses it for its own `returnTo` literal —
 * but nothing here reads an env var or any server-only input, so keeping the module itself free of
 * the marker means it can never trip the "client component value-imports server-only" invariant if
 * a future caller needs it directly. (`member-join-path.ts` DID carry the marker, for the `/join/`
 * prefetch-scan reason its docblock stated; that reason dies with the `/join/` substring.)
 *
 * Kept in the exact shape `isMeetingCallPath` recognizes — round-tripped by this module's own test
 * — so the builder and the predicate can never drift apart.
 */
export function memberCallPath(meetingId: string): string {
  return `/meetings/${meetingId}/call`;
}
