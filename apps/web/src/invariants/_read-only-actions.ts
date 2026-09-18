/**
 * `_read-only-actions` — the SINGLE list of Server Actions permitted to authenticate with a
 * bare `requireUser()` instead of `requireOnboardedUser()`, shared by the two invariants that
 * police it from opposite directions:
 *
 *   · `onboarding-mutation-gate.test.ts` — "is this action allowed to skip the onboarding
 *     gate at all?" It scans each action's OWN source.
 *   · `conversation-access-read-only.test.ts` — "does it stay read-only in the code it
 *     CALLS?" It follows the one import that can silently turn a read into a write.
 *
 * ⚠⚠ EXTRACTED BECAUSE A HAND-MAINTAINED SECOND COPY ALREADY FAILED. BAL-424 made
 * `resolveConversationAccess` get-or-CREATE, which turned every allowlisted caller into a
 * transitive writer behind a bare `requireUser()`. The follow-up invariant listed its subjects
 * by hand — and listed only two of the THREE affected actions, so
 * `get-proposal-document-download.ts` kept the writing variant while both tests stayed green.
 * Deriving the subject list from the allowlist itself is what makes that class of miss
 * impossible: adding an entry below automatically enrols it in both checks.
 *
 * ⚠ THIS FILE IS NOT A TEST and is deliberately not named like one — vitest collects only
 * `*.test.ts` / `*.spec.ts` under `src`, so a helper module here is imported, never run as a
 * suite. Same convention as `_source-scan.ts`.
 */

/**
 * Server Actions that read the session via bare `requireUser()` and are allowed to, because
 * they perform NO writes/side-effects and stay IDOR-guarded independently of onboarding.
 * Paths are relative to `apps/web/src`, POSIX separators.
 *
 * ⚠ EVERY ENTRY CARRIES A STANDING BAL-424 OBLIGATION: if it resolves conversation access it
 * must use `readConversationAccess` (which `findByContext`s), NEVER `resolveConversationAccess`
 * (which get-or-CREATES). `conversation-access-read-only.test.ts` enforces that automatically
 * for every entry here, including ones added later.
 */
export const READ_ONLY_ALLOWLIST: readonly string[] = [
  // Lists conversation messages/files — pure read.
  //
  // ⚠ ITS SIBLING `get-conversation-file-download.ts` WAS DELETED, NOT MOVED (BAL-431 / OSD-2).
  // The project-request surface retired its in-thread file affordance in favour of the
  // request-level file home below, so there is no longer a request-surface conversation-file
  // reader to allowlist. Do NOT re-add an entry for it. The CASE equivalent
  // (`get-case-file-download.ts`) is untouched and still listed further down.
  'app/(dashboard)/projects/[requestId]/_actions/fetch-thread.ts',
  // ── BAL-431 / ADR-1048 — the request-shared-file reader ───────────────────────────────
  //
  // Mints a short-lived presigned GET for one REQUEST-shared file — no mutation.
  // ⚠ THE STANDING BAL-424 OBLIGATION DOES NOT BIND THIS ONE: it resolves access via
  // `authorizeRequestFileScope`, which performs NO WRITES AT ALL — it never mints a
  // conversation/relationship row, so there is no writing/read-only pair to choose between and
  // no `resolveConversationAccess` (nor any get-or-create) anywhere in its import graph.
  // `conversation-access-read-only.test.ts` therefore does not enrol it (it names no
  // conversation-access module) while `onboarding-mutation-gate.test.ts` still does. Same shape
  // as the BAL-423 meeting-file entries below.
  'app/(dashboard)/projects/[requestId]/_actions/get-request-file-download.ts',
  // Mints a short-lived presigned GET URL for a proposal document — no mutation.
  //
  // ⚠ ITS LENS CHECK RUNS *AFTER* ACCESS RESOLUTION, which is what made the writing variant
  // genuinely exploitable here rather than merely untidy: an un-onboarded member of the owning
  // company authorizes as `client` lens, both rows are INSERTed, and only then is the request
  // rejected on `lens !== 'expert'`.
  'app/(dashboard)/projects/[requestId]/_actions/get-proposal-document-download.ts',
  // ── BAL-423, the meeting-file readers ────────────────────────────────────────────────
  //
  // ⚠ THE STANDING BAL-424 OBLIGATION ABOVE DOES NOT BIND THESE TWO, AND THIS NOTE EXISTS SO
  // THE NEXT READER DOES NOT GO HUNTING FOR A READ-ONLY VARIANT THAT ISN'T THERE. That
  // obligation is specifically about `resolveConversationAccess` being get-or-CREATE. These
  // actions resolve MEETING access via `authorizeMeetingFileAccess`, which performs NO WRITES
  // AT ALL — it never mints a row, so there is no writing/read-only pair to choose between
  // and no meeting-file equivalent of `readConversationAccess` to reach for. Both actions
  // therefore fall outside `conversation-access-read-only.test.ts`'s subject set (they never
  // mention the conversation-access module) while still being enrolled in the gate test.
  //
  // Mints a short-lived presigned GET for one meeting file — no mutation.
  'app/(dashboard)/meetings/[meetingId]/_actions/get-meeting-file-download.ts',
  // Lists a meeting's live files (both in-call sources) — pure read.
  'app/(dashboard)/meetings/[meetingId]/_actions/list-meeting-files.ts',
  // ── BAL-436, the in-call People panel's roster read ───────────────────────────────────
  //
  // ⚠ THE STANDING BAL-424 OBLIGATION DOES NOT BIND THIS ONE EITHER, for a simpler reason
  // than the two meeting-file entries above: it resolves NOTHING locally. It forwards a
  // `GET /meetings/:id/guests` to `apps/api` over the WorkOS-Bearer hop and maps fixed error
  // literals to copy — there is no repository call, no access resolver and no get-or-create
  // pair anywhere in its import graph. `authorizeMeetingParticipation` (the real gate) runs
  // in the other app, on the other side of HTTP.
  //
  // ⚠ IT IS THE ONLY POLLED ACTION ON THE ALLOWLIST — the panel re-reads it every ~10s while
  // it is open — which is a second, independent reason it must never gain a write.
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-guests.ts',
  // ── BAL-134, the in-call state mirror's polled read ───────────────────────────────────
  //
  // ⚠ THE SAME REASONING AS THE ENTRY ABOVE, AND THE SAME TWO PROPERTIES. It resolves NOTHING
  // locally: it forwards a `GET /meetings/:id/state` to `apps/api` over the WorkOS-Bearer hop
  // and maps a status to a `retryable` boolean. There is no repository call, no access
  // resolver and no get-or-create pair anywhere in its import graph, so the standing BAL-424
  // obligation does not bind it. `authorizeMeetingParticipation` (the real gate) runs in the
  // other app, on the other side of HTTP, and collapses every denial to `404`.
  //
  // ⚠ IT IS THE **SECOND** POLLED ACTION ON THIS LIST — every ~10s while a call is live, on
  // every participant's tab — which is an independent reason it must never gain a write.
  //
  // ⚠⚠ ITS SIBLING `end-meeting.ts` IS A MUTATION AND IS DELIBERATELY **NOT** HERE. It uses
  // `requireOnboardedUser()`. Do not "tidy" the pair onto one gate.
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-state.ts',
  // ── BAL-421, the case-surface readers ────────────────────────────────────────────────
  //
  // ⚠ THE STANDING BAL-424 OBLIGATION ABOVE BINDS BOTH OF THESE IN SPIRIT, THOUGH NOT BY THE
  // LETTER OF ITS MODULE NAME. Neither mentions `project-request/resolve-conversation-access`,
  // so `conversation-access-read-only.test.ts` does not enrol them in its subject set — but
  // they resolve a conversation all the same, through `@/lib/cases/resolve-case-access`. That
  // adapter reaches `authorizeEngagementConversation`, whose thread read is
  // `conversationsRepository.findByContext` — a SELECT. It must NEVER become
  // `ensureForContext` / `ensureManyForContexts`: minting a conversation row from a READ path
  // behind a bare `requireUser()` is the exact transitive-write defect BAL-424 closed. A case's
  // thread is provisioned in the same transaction as the case, so there is nothing to ensure.
  //
  // Lists a case conversation's messages/files (keyset pagination) — pure read.
  'app/(dashboard)/cases/[engagementId]/_actions/fetch-case-thread.ts',
  // Mints a short-lived presigned GET for one case file, from EITHER side of the D4 merge.
  // Each origin keeps its own gate (`authorizeMeetingFileAccess` / the case gate + a
  // conversation-scoped lookup); neither performs a write.
  'app/(dashboard)/cases/[engagementId]/_actions/get-case-file-download.ts',
  // ── BAL-437, the in-call chat panel's thread read ─────────────────────────────────────
  //
  // ⚠⚠ THE STANDING BAL-424 OBLIGATION ABOVE BINDS THIS ONE IN SPIRIT, THOUGH NOT BY THE
  // LETTER OF ITS MODULE NAME. It does not mention `project-request/resolve-conversation-access`,
  // so `conversation-access-read-only.test.ts` does not enrol it — but it resolves a
  // conversation all the same, through `@/lib/meetings/meeting-chat-anchor`. That module's
  // thread lookup is `conversationsRepository.findByContext` — a SELECT. It must NEVER become
  // `ensureForContext` / `ensureManyForContexts`: minting a conversation row from a READ path
  // behind a bare `requireUser()` is the exact transitive-write defect BAL-424 closed, and a
  // MEETING path is where it would be easiest to justify ("the call is happening, so the
  // thread should exist"). It should not, and this action must not make it so.
  //
  // Lists an in-call conversation's messages (keyset pagination, `{ kind: 'full' }`) — pure read.
  'app/(call)/meetings/[meetingId]/call/_actions/fetch-meeting-thread.ts',
  // ── BAL-403, the in-call BALANCE panel's polled read ──────────────────────────────────
  //
  // ⚠ A pure read of the in-call drawdown projection. Writes nothing: the audience gate and the
  // membership + capability read both run inside `resolveInCallDrawdown`
  // (`@/lib/credit/resolve-in-call-drawdown`), the same composed gate `page.tsx`'s
  // `resolveBalanceSlot` calls to decide the slot's registration. It is the THIRD polled action
  // on this list — every 10-30s while the Balance slot is registered — which is an independent
  // reason it must never gain a write.
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-drawdown-state.ts',
  // ── BAL-440, the recap recording's playback mint ──────────────────────────────────────
  //
  // ⚠ THE STANDING BAL-424 OBLIGATION DOES NOT BIND THIS ONE, for the same reason as the two
  // meeting-file entries above: it resolves MEETING access via `authorizeMeetingFileAccess`,
  // which performs NO WRITES AT ALL, and `meetingRecordingsRepository.findInMeeting` is a
  // SELECT. There is no get-or-create pair anywhere in its import graph and no
  // conversation-access module is named, so `conversation-access-read-only.test.ts` does not
  // enrol it while `onboarding-mutation-gate.test.ts` still does.
  //
  // Mints a short-lived signed Mux playback URL for one recording segment — no mutation.
  'app/(dashboard)/meetings/[meetingId]/_actions/get-meeting-recording-playback.ts',
];

/**
 * BAL-132 — Server Actions that authenticate with **NOTHING AT ALL**, because their caller has
 * no account by definition.
 *
 * ── ⚠⚠ WHY THIS LIST HAD TO EXIST ───────────────────────────────────────────────────────
 *
 * `onboarding-mutation-gate.test.ts` scans for modules calling BARE `requireUser(`. That makes
 * it **structurally blind to a module calling no auth helper at all** — such a module simply
 * never enters the offending set. So BAL-132's two anonymous lobby actions passed that
 * invariant, and their docblocks said so accurately ("IT PASSES THAT INVARIANT … VERIFIED") —
 * but passing it was never EVIDENCE OF SAFETY, and nothing stopped a third, accidentally
 * unauthenticated mutating action landing under `_actions/` and passing just as quietly.
 *
 * This list closes that hole from the other side: the paired assertion proves the set of
 * `'use server'` modules under `app/join/` that reference NO auth or session primitive at all is
 * EXACTLY this list. A new one fails CI; deleting one from here without deleting the file fails
 * CI too.
 *
 * ⚠ THE ASSERTION IS SCOPED TO `app/join/`, AND THAT LIMIT IS DELIBERATE. It answers the NARROWER
 * BAL-132 question ("does this module look at its caller at all?") over the one tree where an
 * anonymous mutating action is a live risk, and it is what keeps this list honest.
 *
 * ⚠⚠ BAL-568 — THE REPO-WIDE, STRICTLY STRONGER PROPERTY NOW EXISTS, and this list is REUSED by
 * it rather than duplicated. `account-liveness-gate.test.ts` asserts that every `'use server'`
 * module in `apps/web/src` reaches a LIVE-CHECKED seam — in its own source, one import hop away,
 * or one further re-export hop — or is named in an allowlist with a written reason. Its allowlist
 * is the UNION of {@link LIVE_CHECK_EXEMPT_ALLOWLIST} and this list, and it asserts the two are
 * disjoint. The "~35 wrapper-gated actions a name scan cannot see through" obstacle recorded here
 * is RESOLVED, not deferred: `_action-auth-scan.ts` follows imports (measured: 26 modules resolve
 * at one hop, 5 at two). Do NOT "fix" either invariant by deleting a scope filter and growing a
 * list.
 *
 * ── ⚠ WHAT AN ENTRY HERE IS ASSERTING ───────────────────────────────────────────────────
 *
 * NOT "this action needs no authorization" — it is asserting that **the authorization is
 * SERVER-SIDE AND ELSEWHERE**, and naming where. Both entries below forward to `apps/api`
 * routes that are public BY DESIGN and that carry the real gate: meeting resolution, liveness,
 * the participant and queue caps, the token compare, and rate limiting — collapsing every
 * failure into one non-enumerating literal.
 *
 * ⚠ DO NOT ADD AN ENTRY TO MAKE A FAILING BUILD GREEN. The default for a mutating Server Action
 * is `requireOnboardedUser()`; an anonymous one needs a written reason, its own rate limit, and
 * a non-enumerating response.
 *
 * ⚠⚠ BAL-445's THREE GUEST **READ** ACTIONS ARE NOT ON THIS LIST, AND MUST NEVER BE ADDED.
 * `listGuestMeetingFilesAction`, `getGuestMeetingFileDownloadAction` and
 * `fetchGuestMeetingThreadAction` authenticate via `resolveMeetingGuestSubject` — a per-request
 * resolver that turns a presented token into a persisted, revocable subject and fails closed,
 * the same shape as `getSession()` / `getCurrentUser()`. That is `AUTH_HELPERS`' entry, not
 * this list's: adding a guest READ here would silently reclassify an authorized read as
 * "authenticates with nothing at all", which is precisely the disclosure this file's own
 * opening paragraph warns about. If a future reader is tempted to add one because it is
 * anonymous in the ordinary sense (no WorkOS session), the answer is still `AUTH_HELPERS` — a
 * token IS a credential.
 *
 * ⚠⚠ WHERE THOSE THREE ACTUALLY LIVE: {@link GUEST_READ_ALLOWLIST}, below. Round-3 human
 * review of PR #241 found that adding `resolveMeetingGuestSubject` to `AUTH_HELPERS` closed
 * one hole (these three no longer misclassify as "public") but opened another: nothing else
 * enrolled them in ANY invariant, so a future `app/join/_actions/*` module that merely
 * *mentions* `resolveMeetingGuestSubject` and then writes through a repository would pass
 * `onboarding-mutation-gate.test.ts` (it authenticates), `join-link-never-writes.test.ts` (it
 * excludes `_actions` entirely) and `conversation-access-read-only.test.ts` (its subjects come
 * from `READ_ONLY_ALLOWLIST`, which this isn't on) — all three, silently. `GUEST_READ_ALLOWLIST`
 * is the fourth invariant that closes that gap: it asserts EXACT SET EQUALITY against every
 * `app/join/_actions/*` module referencing `resolveMeetingGuestSubject`, and asserts each one
 * touches no WRITE member on any repository it reaches. It is designed to fail the moment
 * BAL-486 (which removes the `sender_user_id` schema constraint — one of the two remaining
 * brakes on a guest write, the other being the `party: access.side` type error) lands a write
 * on this surface without a deliberate edit here. **The property it enforces: reads only, never
 * an act, never money.**
 */
export const PUBLIC_ACTION_ALLOWLIST: readonly string[] = [
  // An ANONYMOUS visitor forwarded a bare meeting URL knocks to join the admission queue. They
  // have no account BY DEFINITION — that is the entire premise of a waiting-to-join lobby.
  // Authorization: `apps/api`'s `claimLobbyPlace` (meeting + liveness + both caps), behind the
  // lobby route's per-visitor, per-meeting-visitor and per-peer windows.
  'app/join/_actions/claim-lobby-place.ts',
  // A token-bearing GUEST asks "have I been let in yet?". The ≥256-bit token IS the credential;
  // a guest has no WorkOS session to send a Bearer from. Authorization: `apps/api`'s
  // `joinMeetingAsGuest`, which resolves the token hash and refuses everything else identically.
  'app/join/_actions/poll-guest-admission.ts',
];

/**
 * BAL-445, fix-round-3, G1 — the three Server Actions that authenticate a token-bearing GUEST
 * via `resolveMeetingGuestSubject` (an `AUTH_HELPERS` entry) and perform NO write anywhere in
 * their own source. Enforced from BOTH directions by `guest-read-allowlist.test.ts`:
 *   - every `app/join/_actions/*` module referencing `resolveMeetingGuestSubject` must be here
 *     (a new guest action cannot land silently);
 *   - every entry here must still reference no write member on any `xxxRepository` it touches
 *     (an existing entry cannot grow a write silently either).
 *
 * Paths are relative to `apps/web/src`, matching every other list in this file.
 *
 * ⚠ BAL-439 ADDED A GUEST **PAGE**, NOT A GUEST ACTION, AND THIS LIST IS UNCHANGED BY DESIGN.
 * The guest recap (`app/join/[token]/recap/[meetingId]/page.tsx`) reuses TWO of the three
 * entries below verbatim (the Files card fetches through the shipped guest actions client-side)
 * and adds no fourth. Its own gate and loader are pinned instead in
 * `guest-read-allowlist.test.ts`'s `ALLOWED_DB_IMPORTS` / `ALLOWED_LIB_REPOSITORY_CALLS`
 * (transitive pins), plus a new coverage assertion over the whole `app/join` tree — see that
 * file's BAL-439 additions for what actually covers the page.
 */
export const GUEST_READ_ALLOWLIST: readonly string[] = [
  // Lists a meeting's files for a guest — `meetingFilesRepository.listByMeeting`, a SELECT.
  'app/join/_actions/list-guest-meeting-files.ts',
  // Mints a short-lived presigned GET for one meeting file — `meetingFilesRepository.findInMeeting`,
  // a SELECT; the presign itself talks to R2, never a repository.
  'app/join/_actions/get-guest-meeting-file-download.ts',
  // Lists an in-call thread's messages for a guest — `conversationsRepository.listMessagesPage`,
  // a SELECT (keyset-paginated).
  'app/join/_actions/fetch-guest-meeting-thread.ts',
];

/**
 * BAL-568 — the `'use server'` modules that reach NO live-checked actor seam, and are ALLOWED to,
 * each with a written reason and a `proof` substring that reason genuinely rests on.
 *
 * Enforced by `account-liveness-gate.test.ts`: the UNION of this list and
 * {@link PUBLIC_ACTION_ALLOWLIST} must equal the unresolved set EXACTLY, both directions, and the
 * two lists must be disjoint. A new ungated action fails CI; deleting an entry without gating the
 * file fails CI too; an entry whose `proof` has drifted out of the file fails CI as well.
 *
 * ⚠⚠ ELEVEN ENTRIES IN TOTAL (nine here + the two public ones), NOT FORTY. The forbidden move —
 * deleting the filter and growing the allowlist to absorb every wrapper-gated action — is what
 * import-following exists to make unnecessary. Re-measured 2026-09-19: of 182 `'use server'`
 * modules, **140 resolve at depth 0, 26 at one import hop, 5 at two, and 11 are unresolved**.
 * (It read twelve/ten until `app/review/_actions/submit-token-review.ts` was GATED rather than
 * allowlisted — see the removal note below.) `account-liveness-gate.test.ts` B7 and B8 assert both
 * counts, so this prose and the assertions cannot drift apart silently again.
 *
 * ⚠ WHAT AN ENTRY IS ASSERTING: not "this action needs no authorization", but that **there is no
 * account to check yet, or checking one would break the only path back**. Every entry is
 * pre-identity, token-bearing, or the sign-out itself. An entry that is merely "convenient to
 * exempt" does not belong here — the default for any authenticated Server Action is that the gate
 * comes for free through `requireUser` / `requireOnboardedUser` / `withAuth`.
 */
export const LIVE_CHECK_EXEMPT_ALLOWLIST: readonly {
  rel: string;
  reason: string;
  proof: string;
}[] = [
  {
    rel: 'lib/auth/actions/sign-in.ts',
    reason:
      'Establishes the session — there is no resolved actor to check yet, and the users row may be created here (the orphaned-WorkOS-identity arm). A suspended account that signs in is ejected one redirect later by checkSessionDrift with the correct BAL-197 copy, and the resulting session GRANTS NOTHING because every seam now re-reads the live row. Gating the highest-risk auth path in the app, which also touches row creation, buys marginally nicer error timing for real risk.',
    proof: 'authenticateWithPassword(',
  },
  {
    rel: 'lib/auth/actions/sign-up.ts',
    reason:
      'Creates the users row. There is no row to read, so there is nothing to check liveness against.',
    proof: 'signUpAction(',
  },
  {
    rel: 'lib/auth/actions/verify-email.ts',
    reason:
      'Completes sign-up by verifying the emailed code, before any session-bound actor exists to resolve.',
    proof: 'verifyEmailAction(',
  },
  {
    rel: 'lib/auth/actions/oauth.ts',
    reason:
      'Returns a WorkOS authorization URL and redirects to it. Pre-identity by definition — the caller has not been identified yet.',
    proof: 'initiateGoogleOAuth(',
  },
  {
    rel: 'lib/auth/actions/forgot-password.ts',
    reason:
      'Anonymous by design and must not enumerate accounts, so it must not branch on account state at all — a different response for a suspended address would be exactly the disclosure this action is written to avoid.',
    proof: 'forgotPasswordAction(',
  },
  {
    rel: 'lib/auth/actions/reset-password.ts',
    reason:
      'Token-bearing recovery: the emailed token IS the credential, and there is no session. Gating it would lock a recovering user out of the only path back.',
    proof: 'resetPasswordAction(',
  },
  {
    rel: 'lib/auth/actions/logout.ts',
    reason:
      '⚠ MUST STAY UNGATED. A suspended or soft-deleted user must be able to sign out; a liveness gate here traps exactly the people who most need to leave, and it is the action that tears the cookie down.',
    proof: 'session.destroy()',
  },
  {
    rel: 'app/dev/_actions/seed.ts',
    reason:
      'Dev-only seeding proxy: a real NODE_ENV refusal precedes every network call and every write (callSeedEndpoint returns before fetching in production), and the Fastify /dev/seed routes are not registered in production either — two independent gates. Verified against the file, not assumed.',
    proof: "process.env.NODE_ENV === 'production'",
  },
  // ⚠⚠ `app/review/_actions/submit-token-review.ts` WAS AN ENTRY HERE AND IS NOT ANY MORE (fix
  // round 1, F6) — it is GATED now, not allowlisted. Its reason claimed "the reviewer may have no
  // users row at all", which was simply FALSE: `review_invite_tokens.reviewer_user_id` is a
  // `notNull` FK to `users.id`, so the row always exists. The false premise concealed a real
  // residual — a suspended or soft-deleted user holding a live 30-day magic link could still
  // submit a review — which is precisely the "justification nobody re-checks" failure this file's
  // own header records from BAL-424. Do not re-add it; gate the subject instead.
  {
    rel: 'lib/project-request/actions/refetch-project-taxonomies.ts',
    reason:
      'Public reference data shown on the UNAUTHENTICATED expert profile — its own docblock says gating it would break anonymous browse. It reads a taxonomy that degrades to empty on error, writes nothing, and exposes nothing account-specific.',
    proof: 'loadProjectRequestTaxonomies()',
  },
];

/**
 * BAL-568 (fix round 1, F1) — the **ROUTE HANDLERS** that reach no live-checked actor seam, and are
 * allowed to.
 *
 * ⚠⚠ THIS LIST EXISTS BECAUSE A ROUTE HANDLER SHIPPED UNGATED AND NO INVARIANT COULD SEE IT.
 * `account-liveness-gate.test.ts` walks `'use server'` modules, and a Route Handler is not one — so
 * all thirteen of them sat outside the corpus. `app/api/auth/switch-workspace/route.ts` resolved its
 * actor with a bare `getSession()`, then WROTE to `users` and re-sealed a fresh seven-day cookie: a
 * suspended account both acted and had its session renewed. `route-handler-liveness-gate.test.ts`
 * closes the corpus gap; this list is what keeps it honest.
 *
 * Same shape and same rules as {@link LIVE_CHECK_EXEMPT_ALLOWLIST}: compared for exact set
 * equality in both directions, never used to filter, every `proof` re-checked against the file.
 */
export const ROUTE_HANDLER_EXEMPT_ALLOWLIST: readonly {
  rel: string;
  reason: string;
  proof: string;
}[] = [
  {
    rel: 'app/api/auth/callback/route.ts',
    reason:
      'The WorkOS callback that MINTS the session. There is no resolved actor yet and the users row may be created right here, so there is nothing to read liveness from — the same ruling as sign-in (A4). A suspended account that completes a callback is ejected one render later by checkSessionDrift with the correct BAL-197 copy, and the session it holds meanwhile grants nothing because every seam re-reads the live row.',
    proof: 'authenticateWithCode(',
  },
  {
    rel: 'app/api/auth/session-sync/route.ts',
    reason:
      '⚠ MUST STAY UNGATED AT THE SEAM — it IS the teardown route. It reads the live row itself through classifyAccountRefusal, destroys the cookie and lands on /login?error=..., and every other refusal path in the app redirects HERE. A gate in front of it would throw before it could clear the cookie, leaving a suspended user in an unbreakable loop with no recovery path — the same reasoning that keeps getSession() ungated.',
    proof: 'classifyAccountRefusal(dbUser)',
  },
  {
    rel: 'app/api/auth/test-login/route.ts',
    reason:
      'The seeded E2E harness. It 404s unless E2E_TEST_SECRET is set (production never sets it) and then demands a constant-time header match, so it is unreachable in production and resolves no real actor — it MINTS a session for a seeded fixture, which puts it in the same class as the callback above.',
    proof: 'E2E_TEST_SECRET',
  },
  {
    rel: 'app/api/health/route.ts',
    reason:
      'An unauthenticated liveness probe. It reads no session, resolves no actor and touches no database — there is no account for a gate to check.',
    proof: "status: 'ok'",
  },
  {
    rel: 'app/api/sentry-example-api/route.ts',
    reason:
      'A deliberately throwing fixture that exercises Sentry error reporting. It reads no session and resolves no actor.',
    proof: 'SentryExampleAPIError',
  },
];

/** The module whose two variants differ by whether they WRITE. */
export const CONVERSATION_ACCESS_MODULE = 'project-request/resolve-conversation-access';

/** The get-or-create variant. Forbidden in anything on {@link READ_ONLY_ALLOWLIST}. */
export const WRITING_ACCESS_RESOLVER = 'resolveConversationAccess';

/**
 * The read-only variant. Required in an allowlisted action that resolves conversation access.
 *
 * ⚠ IT IS A PREFIX-FREE NAME relative to the writing one — `readConversationAccess` is not a
 * substring of `resolveConversationAccess` and vice versa — so a plain `includes` check cannot
 * confuse them in either direction.
 */
export const READ_ONLY_ACCESS_RESOLVER = 'readConversationAccess';
