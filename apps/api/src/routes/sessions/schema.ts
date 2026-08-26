import { z } from 'zod';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

/**
 * `POST /sessions` — the acting member comes from auth; the wallet is resolved by the service.
 * `estimatedMinutes` is capped at `MAX_SESSION_MINUTES` (the reaper's safety bound) so an absurd
 * estimate can't over-size the pre-connect hold. `companyId` (BAL-401) is the OPTIONAL chosen
 * billing company — capability-gated in the service (only a company the caller holds
 * CONSUME_CREDITS on is honoured), never an arbitrary wallet selector.
 *
 * ⚠⚠ G1 (second review round) — `meetingId` IS NOW ABSENT FROM THIS SCHEMA, DELIBERATELY, AND
 * IT MUST STAY THAT WAY. It used to be an OPTIONAL field here (BAL-129 / D5), on the stated
 * reasoning that "nothing sends it on this route, and nothing is expected to" — but an absent
 * *expectation* is not an absent *acceptance*: a company member holding `CONSUME_CREDITS` could
 * call this route directly with `{ expertProfileId, estimatedMinutes, companyId, meetingId }`
 * and no `durationSource`. The repository defaults the latter to `'live_capture'`, producing a
 * row with `meeting_id` SET but `duration_source='live_capture'` — which
 * `openCaseSessionBestEffort`'s admission-time idempotency pre-check (`findIdByMeetingId`) then
 * finds and no-ops on, so the real `'presence'` session BAL-466 opens never gets created. The
 * consultation meters, looks fully billed, and settles nothing. `openSession`'s coherence guard
 * (`open-session.ts`) is now bidirectional against exactly this — `meetingId` without
 * `durationSource: 'presence'` is refused — but the wire accepting the field at all was half of
 * the bypass, so it is now removed rather than merely guarded twice.
 *
 * ⚠ THERE IS DELIBERATELY NO `engagementId` FIELD, AND THERE MUST NEVER BE ONE, FOR THE SAME
 * REASON: the service derives the engagement from `meetingId` alone, server-side, and checks
 * that it names both the capability-gated company and the requested expert. Accepting an
 * `engagementId` from the wire would re-create the divergent `(meetingId, engagementId)` pair
 * that `OpenSessionInput`'s docblock warns about — a session that bills one engagement while
 * BAL-425's sweep ages out another. One resolution, one source.
 *
 * ⚠ BAL-466 opens the Case consultation's session from the API SERVICE
 * (`joinMeetingAsMember` → `openSession`), not over this wire — `meetingId` and
 * `durationSource` are both SERVICE inputs (`OpenSessionServiceInput`), never wire fields.
 * Meeting-binding and provenance are server decisions derived from the admission seam, never a
 * value a client supplies; a client that could choose either could open an unsettleable
 * `'presence'` session with no real meeting, or a `meetingId`-bearing `'live_capture'` session
 * that silently shadows the real one, exactly as above.
 */
export const openSessionBodySchema = z
  .object({
    expertProfileId: z.string().uuid(),
    estimatedMinutes: z.number().int().positive().max(MAX_SESSION_MINUTES),
    companyId: z.string().uuid().optional(),
  })
  .strict();
export type OpenSessionBody = z.infer<typeof openSessionBodySchema>;

/** The `:id` path param for every per-session route. */
export const sessionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * BAL-399 — `POST /internal/sessions/:id/finalize-duration` (the BAL-133 consumer seam; system-
 * authed internal route, same posture as the internal `/credit` routes — NOT client-callable).
 * `minutes` is the confirmed billable duration (drawn in full, no ceiling clamp); `path` records
 * which BAL-133 outcome finalized it.
 *
 * ⚠ BAL-412 (D9) REMOVED `settledByUserId`. `finalizeExternalDuration` only ever acts when
 * `durationSource === 'external'`, which nothing on main sets — accepting the field would have
 * advertised audit attribution the route silently discarded. BAL-133 owns audit attribution
 * for the external path if it is ever needed; the API stops advertising a field it does not use.
 */
export const finalizeDurationBodySchema = z.object({
  minutes: z.number().int().min(0).max(MAX_SESSION_MINUTES),
  path: z.enum(['confirmed', 'disputed', 'auto_confirmed']),
});
export type FinalizeDurationBody = z.infer<typeof finalizeDurationBodySchema>;
