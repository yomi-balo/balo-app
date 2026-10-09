/**
 * `expert.application_submitted` — the applicant's "we received your application" email.
 *
 * ⚠ DEFINED ONCE, HERE, and re-exported from `./index`. Both apps import it: the web submit
 * action publishes it and the api's notification layer types it. A payload declared in each
 * app lets the two copies drift while both compile.
 *
 * PURE. No I/O.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 */

/**
 * Recipient `self` via `userId`. `applicationId` is the `expert_profiles.id`.
 *
 * `correlationId` IS THE `expert_application.submitted` AUDIT ROW ID that the submit wrote —
 * unique per WRITE, so a resubmission after a decline is not deduped away against the first
 * submission's retained completed BullMQ job. Do NOT use the profile id: the dispatcher builds
 * its jobId from the raw correlationId, and a per-profile id silences every submit after the
 * first.
 */
export interface ExpertApplicationSubmittedPayload {
  correlationId: string;
  userId: string;
  applicationId: string;
}

export interface BuildExpertApplicationSubmittedPayloadInput {
  /** The applicant. */
  userId: string;
  expertProfileId: string;
  /** The id of the `expert_application.submitted` audit row the submit appended. */
  auditEventId: string;
}

/**
 * The ONE mapping from a committed submit to its notification payload, shared by the web
 * submit action and the api invariant test, so both exercise the shipped correlation rule.
 */
export function buildExpertApplicationSubmittedPayload(
  input: BuildExpertApplicationSubmittedPayloadInput
): ExpertApplicationSubmittedPayload {
  return {
    correlationId: input.auditEventId,
    userId: input.userId,
    applicationId: input.expertProfileId,
  };
}
