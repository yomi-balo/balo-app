import 'server-only';

import {
  conversationsRepository,
  engagementsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import {
  conversationSubjectForMeetingContext,
  engagementConversationIsWritable,
  type ConversationSubject,
} from '@balo/shared/conversations';
import { isThreadOpenStatus } from '@/lib/project-request/conversation-view-types';
import {
  authorizeMeetingFileAccess,
  type MeetingFileAccessSide,
} from './authorize-meeting-file-access';

/**
 * BAL-437 — RESOLVE A MEETING TO THE CONVERSATION THREAD ITS IN-CALL CHAT WRITES INTO.
 *
 * ⚠⚠ **IT ADDS NOTHING TO THE AUTHORIZATION DECISION.** The whole gate is
 * `authorizeMeetingFileAccess`, composed verbatim. This module adds two PURE steps and at most
 * one extra read on top of it.
 *
 * ── ⚠⚠ THE GATE'S NAME SAYS "FILE". THAT IS HISTORICAL, NOT A SCOPE LIMIT ───────────────
 *
 * `authorizeMeetingFileAccess` is *the* meeting-participation gate on the web tier: it resolves
 * meeting → primary context → the owning party from the context's OWN row → the actor's side,
 * in that order, before any coherence or state check; it collapses every denial into one
 * `meeting_not_found` literal (the log keeps the shape); and it discharges ADR-1045's
 * no-FK/no-RLS tenancy obligation. Chat sits in exactly the same read/act class as files.
 * **Do not fork it and do not rename it here** — four shipped callers and an invariant read it
 * by name.
 *
 * ── ⚠⚠ WHY THE ENGAGEMENT-CAPABILITY AXIS IS **NOT** USED, FOR THE THIRD TIME ───────────
 *
 * Reading a thread is a READ, and CLAUDE.md states that a `true` from `hasEngagementCapability`
 * "authorizes the ACT, never the READ". Posting an in-call message is not on that axis either:
 * neither `host_meetings` (Daily owner token / admit-deny / end call) nor `manage_engagement`
 * (reschedule, expert-side cancel, request resolution) covers "say something in the call". And
 * the holder set is wrong in BOTH directions — it excludes agency role `expert` (the colleague
 * actually on the call) and excludes every client-side actor structurally.
 * `authorize-conversation-context.ts` and `authorize-meeting-file-access.ts` settled this
 * identically; this is the third application of one argument, not a new one.
 *
 * ⚠ `meeting-call-no-lens-gate.test.ts` MECHANICALLY FORBIDS `hasEngagementCapability` in the
 * scanned call subtree. This module lives OUTSIDE that scan (it is `server-only` and
 * legitimately imports `@/lib/logging` transitively and `@balo/db` directly — the same
 * carve-out `guests-api-client.ts` and `join-api-client.ts` hold), which is precisely why it is
 * deliberately ABSENT from `CALL_LIB_FILES` and therefore not pinned. The four Server Actions
 * that call it ARE scanned, and none of them may name that seam.
 *
 * ── ⚠⚠ NO SECOND TENANCY GATE ON THE CONVERSATION ───────────────────────────────────────
 *
 * The anchor is derived from the SAME `subject` the meeting gate already proved ownership of,
 * so `authorizeEngagementConversation` would be a redundant round trip against a party that has
 * already been resolved. What is NOT redundant is the THREAD'S OWN LIFECYCLE, which is the only
 * thing added — and which the two grains answer differently. See `resolveMeetingChatAccess`'s
 * "two arms, two policies" note before touching either branch.
 *
 * ── ⚠⚠ EVERY LOOKUP HERE IS A `SELECT`. NEVER AN `ensure` ───────────────────────────────
 *
 * `conversationsRepository.findByContext` only. Minting a conversation row from a meeting path
 * would be the transitive-write defect BAL-424 closed — and `fetchMeetingThreadAction` sits
 * behind a bare `requireUser()`, which is where it would be worst.
 */

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingChatSide = MeetingFileAccessSide;

export interface MeetingChatAnchor {
  readonly conversationId: string;
  readonly subject: ConversationSubject;
  /**
   * ⚠⚠ **THIS FIELD IS THE ENGAGEMENT ARM'S ANSWER ONLY.** On the RELATIONSHIP arm it is always
   * `true`, because a relationship whose thread is not open yields NO ANCHOR AT ALL rather than
   * a read-only one — see {@link resolveMeetingChatAccess}'s "two arms, two policies" note.
   *
   * ⚠ WRITE access only. On the engagement arm READ access is NOT gated on this — a closed
   * case's thread stays fully readable and only the composer disables. That is the shipped split
   * (`fetch-case-thread.ts` has no writability check; `post-case-message.ts` refuses on one).
   *
   * ⚠⚠ `null` ⇒ **NOT RESOLVED**, because the caller passed `withWritability: false`. It is not
   * "unknown, assume open": every consumer must treat it as NOT writable. `=== true` is the only
   * safe test, and both shipped consumers use it.
   */
  readonly writable: boolean | null;
}

export type MeetingChatAccess =
  | {
      readonly ok: true;
      readonly side: MeetingChatSide;
      /**
       * ⚠⚠ `null` ⇒ THIS MEETING HAS NO CONVERSATION ANCHOR, AND THE CHAT SLOT IS THEN
       * **ABSENT** — no toolbar button, no More-sheet row, no panel. Three shapes land here and
       * they are deliberately indistinguishable to the caller:
       *
       *   · `project_discovery` — one request fans out to MANY invited experts' relationships,
       *     so it names no single thread. ⚠ THE MEETING STILL HAS REACTIONS: they are
       *     meeting-grain and need no anchor;
       *   · a `request_interaction` whose relationship is NOT in an open thread status — the
       *     declined/withdrawn case. ⚠ SEE THE POLICY NOTE ON `resolveMeetingChatAccess`: on
       *     this arm a closed thread is ABSENT, not read-only;
       *   · the anchor resolves but no conversation row exists — the thread was never provisioned.
       *
       * ⚠⚠ **`admin` AND `ambiguous` DO NOT LAND HERE, AND AN EARLIER VERSION OF THIS LIST SAID
       * THEY DID.** `selectPrimaryMeetingContext` drops `admin` rows, so an admin-only meeting
       * resolves to a primary context of `none` and `authorizeMeetingFileAccess` DENIES —
       * `{ ok: false, code: 'meeting_not_found' }`, before the pure rule is ever reached. Two or
       * more distinct holder contexts resolve to `ambiguous` and are denied identically. So an
       * admin call gets NO chat, NO reactions and NO realtime token at all; its artefacts resolve
       * on the PLATFORM axis (ADR-1035). Only `project_discovery` is "reactions, no chat".
       *
       * Absence IS this platform's rendering of "this call doesn't have chat", and it is
       * strictly better than a button that opens a panel whose only content is an apology.
       */
      readonly anchor: MeetingChatAnchor | null;
      readonly meetingId: string;
    }
  /** ⚠ ONE literal, inherited from the gate. There is deliberately no `forbidden`. */
  | { readonly ok: false; readonly code: 'meeting_not_found' };

export interface ResolveMeetingChatAccessInput {
  readonly meetingId: string;
  readonly userId: string;
  /**
   * ⚠ `false` ⇒ SKIP THE **ENGAGEMENT** ARM'S LIFECYCLE READ and report `writable: null`.
   *
   * For a caller that needs the anchor but never the composer verdict — today that is
   * `createMeetingRealtimeTokenAction`, which only wants the conversation channel NAME. It saves
   * one indexed read on a path that re-runs on every 15-minute token refresh.
   *
   * ⚠⚠ **IT DOES NOT SKIP THE RELATIONSHIP ARM'S STATUS READ, AND IT MUST NOT.** On that arm the
   * status decides whether there is an ANCHOR at all (see the policy note below), so skipping it
   * would hand a `conversation:{id}` subscribe capability to a member of a DECLINED
   * relationship — the exact disclosure this module closes.
   */
  readonly withWritability?: boolean;
}

/**
 * The ENGAGEMENT arm's writability: is a case's thread still open to new messages?
 *
 * ⚠⚠ IT REUSES THE SHIPPED PREDICATE AND WRITES NO SECOND DEFINITION —
 * `engagementConversationIsWritable` (`@balo/shared/conversations`), the same one
 * `postCaseMessageAction` refuses on.
 *
 * ⚠ WHY WRITABILITY IS CHECKED AT ALL, given BAL-423 shipped file upload with NO lifecycle
 * gate: the closed-case read-only rule is a shipped PLATFORM rule with its own pure predicate.
 * An in-call composer that wrote into a closed case's thread anyway would be a second, laxer
 * answer to the same question — and the two surfaces render the SAME thread. One indexed read.
 *
 * ⚠ A MISSING ROW IS NOT WRITABLE. Fail closed: the thread exists, so its parent should too,
 * and "cannot be shown to be open" resolves to read-only rather than to open.
 */
async function resolveEngagementWritable(contextId: string): Promise<boolean> {
  const engagement = await engagementsRepository.findById(contextId);
  return engagement !== undefined && engagementConversationIsWritable(engagement.status);
}

/**
 * The RELATIONSHIP arm's admissibility: may this thread be SEEN at all?
 *
 * ⚠⚠ IT REUSES `isThreadOpenStatus`, THE SHIPPED PROJECT-THREAD PREDICATE, and writes no second
 * definition. ⚠ A MISSING ROW IS NOT OPEN — fail closed, same rule as the engagement arm.
 */
async function relationshipThreadIsOpen(contextId: string): Promise<boolean> {
  const relationship = await requestExpertRelationshipsRepository.findById(contextId);
  return relationship !== undefined && isThreadOpenStatus(relationship.status);
}

/**
 * Fail-closed participation authorization for a meeting's CHAT surface, plus the thread anchor.
 *
 * Denial collapses into one `meeting_not_found` literal (the gate's, unchanged): a cross-tenant
 * `meetingId` and a nonexistent one are indistinguishable on the wire.
 *
 * ── ⚠⚠ **TWO ARMS, TWO POLICIES — AND THE ASYMMETRY IS DELIBERATE** ─────────────────────
 *
 * A non-open thread status means different things on the two grains, so it gets different
 * answers. Both answers MATCH THE SHIPPED SURFACE that already renders the same thread:
 *
 *   · **ENGAGEMENT grain** (`case`, `project_kickoff`, `package_session`, `retainer_checkin`) —
 *     a COMPLETED or CANCELLED case stays fully READABLE and only the composer disables. That
 *     is `fetch-case-thread.ts` (no writability check) beside `post-case-message.ts` (refuses
 *     on one), verbatim. The engagement happened; its record does not disappear because it
 *     closed. So: anchor RETURNED, `writable: false`.
 *
 *   · **RELATIONSHIP grain** (`request_interaction`) — a DECLINED or withdrawn relationship is
 *     not a closed record, it is a relationship that never opened. The shipped project-request
 *     surface refuses the thread ENTIRELY on `isThreadOpenStatus`, and
 *     `createConversationRealtimeTokenAction` refuses to mint a `conversation:{id}` subscribe
 *     grant for one. So: **NO ANCHOR** — the slot is absent, there is no read, and no channel
 *     is added to the token's capability list.
 *
 * ⚠⚠ AN EARLIER VERSION APPLIED THE ENGAGEMENT POLICY TO BOTH, WHICH WAS A DISCLOSURE. It gated
 * only the WRITE on `isThreadOpenStatus`, leaving the READ and the subscribe grant ungated — so
 * a client-side member could open the in-call panel and read a declined relationship's thread
 * that the project-request surface and the conversation token action both refuse. Same thread,
 * same actor, two answers; the laxer one was reachable from a live call.
 *
 * ⚠ WHAT THIS DOES **NOT** DO: it answers at CALL TIME only. It voids no already-open panel and
 * runs no sweep. A decline mid-call takes effect on the next read and on the next token refresh
 * (≤15 min, `TOKEN_TTL_MS`) — the same bound `authorizeEngagementHost` documents.
 */
export async function resolveMeetingChatAccess(
  input: ResolveMeetingChatAccessInput
): Promise<MeetingChatAccess> {
  const { meetingId, userId, withWritability = true } = input;

  const access = await authorizeMeetingFileAccess({ meetingId, userId });
  if (!access.ok) {
    // ⚠ THE GATE ALREADY LOGGED THE SHAPE at `warn` with its own distinct `reason`. Logging a
    // second line here would double every denial in Axiom for no new information.
    return { ok: false, code: 'meeting_not_found' };
  }

  const noAnchor: MeetingChatAccess = { ok: true, side: access.side, anchor: null, meetingId };

  // 1. THE PURE RULE, CONSUMED — never a second resolver. `conversationSubjectForMeetingContext`
  //    is total over `MeetingContextTypeWithHolder` with a `never` default, so a seventh
  //    holder-bearing label stops typechecking THERE rather than silently defaulting here.
  const subject = conversationSubjectForMeetingContext(access.subject);
  if (subject === null) return noAnchor;

  // 2. A `SELECT`. ⚠ NEVER `ensureForContext` — see the module docblock.
  const conversation = await conversationsRepository.findByContext({
    contextType: subject.contextType,
    contextId: subject.contextId,
  });
  if (conversation === undefined) return noAnchor;

  // 3. THE LIFECYCLE READ — the only thing this module adds to the decision, and the one place
  //    the two arms diverge. See the "two arms, two policies" note above.
  if (subject.contextType === 'relationship') {
    // ⚠ NEVER SKIPPED, even under `withWritability: false`: here the status decides whether
    // there is an anchor AT ALL, which is a read/subscribe question rather than a write one.
    if (!(await relationshipThreadIsOpen(subject.contextId))) return noAnchor;
    return {
      ok: true,
      side: access.side,
      // ⚠ AN OPEN RELATIONSHIP THREAD IS ALWAYS WRITABLE — the only closed shape returns above.
      anchor: { conversationId: conversation.id, subject, writable: true },
      meetingId,
    };
  }

  const writable = withWritability ? await resolveEngagementWritable(subject.contextId) : null;

  return {
    ok: true,
    side: access.side,
    anchor: { conversationId: conversation.id, subject, writable },
    meetingId,
  };
}
