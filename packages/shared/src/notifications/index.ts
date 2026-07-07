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

// BAL-323 client billing captured. The CLIENT (a company owner/admin) submitted
// their company's billing identity for the first time, auto-confirming the
// `client_billing` kickoff gate — targets the ADMINS (in-app "ready to invoice"
// ops nudge, fanned out over `data.adminUserIds`). `correlationId` = companyId so
// the "confirmed" nudge is deduped to once ever per company (billing is a
// company-level, once-ever concern).
export interface BillingDetailsConfirmedPayload {
  correlationId: string; // = companyId — once-ever-per-company dedup
  companyId: string;
  companyName: string; // in-app body — "…confirmed for {companyName} — ready to invoice."
  projectRequestId: string; // deep link to the kickoff board
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

// BAL-332 (D2) expert milestone completed. The delivering EXPERT marked a milestone
// complete on a live engagement — fans out to the CLIENT company owner
// (recipient:'client' via `recipientId`; email + in-app) and the Balo ADMINS
// (recipient:'admin_users' fan-out; in-app). `correlationId =
// `${milestoneId}:${completedAtEpochMs}`` — idempotent per completion, yet a genuine
// revert→re-complete cycle gets a fresh `completedAt` → a new key → re-notifies.
// `recipientId` is absent for a retainer / owner-miss (the client rules skip; admins
// still fire). Copy uses BAL-329 conventions (PROSPECTIVE names the PARTY,
// RETROSPECTIVE names the PERSON "@ agency" first mention).
export interface EngagementMilestoneCompletedPayload {
  correlationId: string; // `${milestoneId}:${completedAtEpochMs}` — idempotent per completion
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  milestoneId: string;
  recipientId?: string; // client company owner user id → recipient:'client'; absent for retainers/no-owner
  expertPartyLabel: string; // {Expert} — email subject (prospective party)
  actorExpertLabel: string; // {actorExpert} — email/in-app body (retrospective person)
  projectTitle: string; // {title} — subject + admin in-app body
  milestoneTitle: string;
  completedOn: string; // "30 Jun 2026" (server, UTC en-GB)
  completionNote?: string; // verbatim when present
  completedCount: number; // {n} — completed live milestones incl. this one
  totalCount: number; // {m} — total live milestones
}

// BAL-332 (D2) expert milestone reverted. The delivering EXPERT moved a completed
// milestone back to in progress — fans out to the CLIENT company owner and the Balo
// ADMINS (in-app both; reverts are never silent). `correlationId =
// `${milestoneId}:reverted:${updatedAtEpochMs}``. `recipientId` absent → client rule
// skips; admins still fire.
export interface EngagementMilestoneRevertedPayload {
  correlationId: string; // `${milestoneId}:reverted:${updatedAtEpochMs}`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  milestoneId: string;
  recipientId?: string; // client owner user id → recipient:'client'
  actorExpertLabel: string; // {actorExpert} — in-app body
  milestoneTitle: string;
}
