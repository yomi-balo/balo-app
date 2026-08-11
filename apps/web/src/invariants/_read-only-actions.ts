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
  'app/(dashboard)/projects/[requestId]/_actions/fetch-thread.ts',
  // Mints a short-lived presigned GET URL for a conversation file — no mutation.
  'app/(dashboard)/projects/[requestId]/_actions/get-conversation-file-download.ts',
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
