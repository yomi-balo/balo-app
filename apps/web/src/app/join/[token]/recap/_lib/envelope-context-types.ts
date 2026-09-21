import type { ConversationSubject } from '@balo/shared/conversations';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

/**
 * BAL-492 — the INVERSE of `conversationSubjectForMeetingContext`
 * (`@balo/shared/conversations`): given the envelope a guest's anchor recap resolved to, which
 * `meeting_context_type` values does the index reverse-read to find every OTHER meeting in it.
 *
 * ⚠⚠ ROUTE `_lib`, NOT `@balo/shared/conversations` — DELIBERATE, NOT AN OVERSIGHT. Two reasons,
 * both stated in `meeting-duration.ts`'s docblock for the identical question: `packages/shared`
 * has no `typecheck` / `lint` / `test` script (`reference_db_shared_no_typecheck_lint_scripts`),
 * and there is exactly ONE consumer of this function (`load-guest-recap-index.ts`), so hoisting
 * it would add a barrel export nobody else needs. Placement here is also what keeps
 * `meeting-call-no-lens-gate.test.ts` untouched: this is not a `lib/meetings/*` module, so it is
 * on neither `CALL_LIB_FILES` nor `PINNED_FILES`.
 *
 * ⚠ THE DRIFT HAZARD THIS PLACEMENT CREATES, AND ITS MITIGATION. The forward map lives in
 * `@balo/shared/conversations`; if a future edit re-anchors a label there (e.g. moves
 * `retainer_checkin` to a different envelope), the `AssertNever` pins below will NOT notice —
 * they only catch a label ADDED to the pgEnum, never one moved between arms of the forward map.
 * The real guarantee is `envelope-context-types.test.ts`'s ROUND-TRIP property test, which
 * derives its expectation from `conversationSubjectForMeetingContext` itself rather than
 * restating the mapping — read that test, not these pins, for "is this still correct".
 */

/** The four engagement-grain labels — all anchored on ONE `engagements.id`. */
const ENGAGEMENT_GRAIN_CONTEXT_TYPES = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
] as const satisfies readonly MeetingContextTypeWithHolder[];

/** The one relationship-grain label. */
const RELATIONSHIP_GRAIN_CONTEXT_TYPES = [
  'request_interaction',
] as const satisfies readonly MeetingContextTypeWithHolder[];

/**
 * Map an envelope back to the `{ contextType, contextId }` pairs
 * `meetingContextsRepository.listMeetingsForContexts` should reverse-read to find every OTHER
 * meeting in it.
 *
 * ⚠ TOTAL BY A `switch` WITH A `never` DEFAULT — the FIRST of two exhaustiveness pins. If
 * `ConversationContextTypeLabel` ever grows a third label, this fails `tsc` until an arm is
 * written for it.
 */
export function meetingContextTypesForEnvelope(envelope: ConversationSubject): ReadonlyArray<{
  readonly contextType: MeetingContextTypeWithHolder;
  readonly contextId: string;
}> {
  switch (envelope.contextType) {
    case 'engagement':
      return ENGAGEMENT_GRAIN_CONTEXT_TYPES.map((contextType) => ({
        contextType,
        contextId: envelope.contextId,
      }));
    case 'relationship':
      return RELATIONSHIP_GRAIN_CONTEXT_TYPES.map((contextType) => ({
        contextType,
        contextId: envelope.contextId,
      }));
    default: {
      const unreachable: never = envelope.contextType;
      return unreachable;
    }
  }
}

/**
 * ⚠⚠ COMPILE-TIME HALF, the SECOND exhaustiveness pin — the `member-join-envelope.ts:37-45`
 * pattern. Catches a SEVENTH `MeetingContextTypeWithHolder` label that nobody assigned to
 * either array above, which the `switch`'s `never` default cannot see (that default only fires
 * on a new `ConversationContextTypeLabel`, not on a new meeting-context label folded into an
 * EXISTING arm).
 *
 * `'project_discovery'` is excluded EXPLICITLY AND BY NAME: it maps to `null` in
 * `conversationSubjectForMeetingContext` (a discovery meeting fans out to many relationships and
 * names no single thread), so it names no envelope and `meetingContextTypesForEnvelope` is never
 * reached for it. Listing it here — rather than omitting it — keeps this assertion TOTAL instead
 * of silently, permanently true.
 */
type MissingEnvelopeContextType = Exclude<
  MeetingContextTypeWithHolder,
  | (typeof ENGAGEMENT_GRAIN_CONTEXT_TYPES)[number]
  | (typeof RELATIONSHIP_GRAIN_CONTEXT_TYPES)[number]
  | 'project_discovery'
>;
type AssertNever<T extends never> = T;
export type AssertEnvelopeContextTypesComplete = AssertNever<MissingEnvelopeContextType>;
