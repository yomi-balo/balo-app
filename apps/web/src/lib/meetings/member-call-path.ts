/**
 * BAL-566 fix round 1 (F1, user ruling J1, 2026-09-18) — the AUTHENTICATED MEMBER's in-call route,
 * `/meetings/{meetingId}/call` (BAL-435, `joinAsMemberAction`).
 *
 * ⚠⚠ NOT `memberJoinPath` (`/join/m/{meetingId}`, the ANONYMOUS GUEST LOBBY). The ruling that
 * introduced this file found that Join on the dashboard Up next card and the expert Calendar had
 * been sending a signed-in member into the anonymous lobby (name + email, `claimLobbyPlaceAction`,
 * no session read). For a `case` meeting the client-side credit session opens ONLY inside
 * `apps/api`'s `joinMeetingAsMember` (`openCaseSessionBestEffort`, side === 'client') — so a
 * member routed through the lobby instead never opens a metered session, and an expert routed
 * there loses the member/host join entirely. Join from both surfaces now goes here instead.
 *
 * ⚠ PURE, NO `server-only` — DELIBERATELY, unlike `member-join-path.ts`. Both current callers
 * (`build-up-next-rows.ts`, `load-expert-calendar.ts`) happen to be `server-only` modules that
 * build the path server-side and pass it down as a plain string, and the call page itself
 * (`app/(call)/meetings/[meetingId]/call/page.tsx`) also uses it for its own `returnTo` literal —
 * but nothing here reads an env var or any server-only input, so keeping the module itself free of
 * the marker means it can never trip the "client component value-imports server-only" invariant if
 * a future caller needs it directly.
 *
 * Kept in the exact shape `isMeetingCallPath` recognizes — round-tripped by this module's own test
 * — so the builder and the predicate can never drift apart.
 */
export function memberCallPath(meetingId: string): string {
  return `/meetings/${meetingId}/call`;
}
