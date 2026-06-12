/**
 * Cross-app notification event payloads shared by apps/api (engine) and apps/web (publisher).
 * BAL-290 establishes this shared home; older event payloads still mirror across the two files —
 * migrate opportunistically.
 */

// BAL-290 (A6.4) changes-requested loop. The CLIENT requested changes on the
// expert's submitted proposal — targets the EXPERT (via `expertProfileId`, the
// resolver hydrates data.expert exactly like project.proposal_accepted), carrying
// the client's section + note for the email/in-app body.
export interface ProjectChangesRequestedPayload {
  correlationId: string; // proposalId — distinct row per round, naturally unique
  projectRequestId: string;
  relationshipId: string;
  expertProfileId: string; // → resolver hydrates data.expert; recipient:'expert'
  clientName: string; // requesting client's display name — email/in-app body
  projectTitle: string; // request title — email/in-app body
  section: string; // which part of the proposal needs work
  note: string; // the client's change note — email/in-app body
}

// BAL-290 (A6.4) proposal versioning. The EXPERT resubmitted as v(n+1) — targets
// the CLIENT (via `recipientId` = client user id, drives recipient:'client'
// resolution exactly like project.proposal_submitted).
export interface ProjectProposalResubmittedPayload {
  correlationId: string; // "<v2ProposalId>--v<version>" — uuid + version suffix
  projectRequestId: string;
  relationshipId: string;
  recipientId: string; // = client user id → resolves recipient:'client'
  expertName: string; // resubmitting expert's display name — email/in-app body
  projectTitle: string; // request title — email/in-app body
  version: number; // the new proposal version (≥2)
  priceCents: number; // updated proposal price — email/in-app body
  currency: string; // e.g. 'aud' — email/in-app body
}
