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

// BAL-333 (D3) expert delivery-plan scope changed. The delivering EXPERT adjusted the
// delivery plan on a live engagement — added a milestone, materially/cosmetically
// edited one, or removed one. Fans out to the CLIENT company owner (recipient:'client'
// via `recipientId`; email + in-app — the client is TOLD, not asked; the price is
// unchanged, stated in copy) and the Balo ADMINS (recipient:'admin_users' fan-out;
// in-app). One event covers add/edit/remove (the subject/body/CTA are identical — only
// `changeSummary` differs); `changeKind` is carried for observability + a future
// divergence seam. Idempotency/debounce lives in `correlationId` (Decision D):
// `${milestoneId}:added|:removed` (one-shot) | `${id}:edited:${updatedAtMs}` (material,
// always re-notifies) | `${id}:edited:${bucket}` (cosmetic title-only, debounced).
// `recipientId` is absent for a retainer / owner-miss (the client rules skip; admins
// still fire). Copy uses BAL-329 conventions (RETROSPECTIVE names the PERSON "@ agency"
// on first mention).
export interface EngagementScopeChangedPayload {
  correlationId: string; // dedup/debounce key — see Decision D
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  milestoneId?: string; // the affected milestone
  recipientId?: string; // client company owner user id → recipient:'client'; absent → client rules skip
  actorExpertLabel: string; // {actorExpert} — retrospective person ("Priya" / "Priya @ CloudPeak")
  projectTitle: string; // {title} — subject + admin in-app body
  changeKind: 'added' | 'edited' | 'removed';
  changeSummary: string; // "added 'Data migration dry-run'" | "removed 'X'" | "updated 'Y'"
}

// BAL-334 (D4) expert requested project completion (active → pending_acceptance).
// The delivering EXPERT marked the whole project complete — it now sits under the
// client's review. Fans out to the CLIENT company owner (recipient:'client' via
// `recipientId`; email = VARIANT 1 `CompletionRequestEmail` + in-app — the client is
// ASKED to review) and the Balo ADMINS (recipient:'admin_users' fan-out; in-app ops
// signal). `correlationId = `${engagementId}:completion_requested:${requestedAtMs}``
// so a withdraw→re-request legitimately re-notifies (fresh `requestedAt`), while a
// dispatcher retry of the SAME request is deduped by jobId. `recipientId` is absent
// for a retainer / owner-miss (the client rules skip; admins still fire). Copy uses
// BAL-329 conventions (PROSPECTIVE names the PARTY; RETROSPECTIVE names the PERSON
// "@ agency" first mention). All dates are pre-formatted UTC strings.
export interface EngagementCompletionRequestedPayload {
  correlationId: string; // `${engagementId}:completion_requested:${requestedAtMs}`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  recipientId?: string; // client company owner user id → recipient:'client'; absent → client rules skip
  clientCompanyName: string; // {clientCompany} — prospective party (email body)
  expertPartyLabel: string; // {expertParty} — prospective party (email subject/body)
  actorExpertLabel: string; // {actorExpert} — retrospective person (email/in-app body)
  projectTitle: string; // {title} — subject + summary + admin in-app body
  milestonesTotal: number; // {m} — total live milestones (email summary)
  requestedDate: string; // "4 Jul" (pre-formatted, UTC)
  autoDate: string; // "11 Jul" (pre-formatted, UTC) — the auto-accept date
  reviewDays: number; // AUTO_ACCEPT_DAYS — the review window length
}

// BAL-334 (D4) expert withdrew the completion request (pending_acceptance → active).
// IN-APP ONLY to the CLIENT company owner and the Balo ADMINS — a withdraw is never
// silent, but it isn't email-worthy. `correlationId =
// `${engagementId}:completion_withdrawn:${nowMs}``. `recipientId` absent → the client
// rule skips; admins still fire.
export interface EngagementCompletionWithdrawnPayload {
  correlationId: string; // `${engagementId}:completion_withdrawn:${nowMs}`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  recipientId?: string; // client company owner user id → recipient:'client'
  actorExpertLabel: string; // {actorExpert} — retrospective person (in-app body)
  projectTitle: string; // {title} — in-app body
}

// BAL-334 (D4) admin cancelled the engagement (active | pending_acceptance →
// cancelled). Fans out to BOTH parties (email + in-app each): the CLIENT company owner
// (recipient:'client' via `recipientId`) and the delivering EXPERT (recipient:'expert'
// via `expertProfileId` → resolver hydrates data.expert). No admin recipient (the
// admin is the actor). `correlationId = `${engagementId}:cancelled`` — a cancel is a
// one-shot terminal transition, so a single deterministic key deduplicates retries.
export interface EngagementCancelledPayload {
  correlationId: string; // `${engagementId}:cancelled`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  recipientId?: string; // client company owner user id → recipient:'client'
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert'
  projectTitle: string; // {title} — email subject/body + in-app body
  cancelledOn: string; // "9 Jul 2026" (pre-formatted, UTC)
  reason: string; // verbatim cancellation reason (email body block)
}

// BAL-338 (D7) client accepted the project (pending_acceptance → completed, method
// 'client'). The CLIENT explicitly accepted — fans out to the delivering EXPERT
// (recipient:'expert' via `expertProfileId`; email + in-app — congratulations, Balo
// handles the final invoice) and the Balo ADMINS (recipient:'admin_users' fan-out;
// email + in-app — THE MONEY TRIGGER: "Ready to invoice: final installment"). No client
// recipient (they just acted). `correlationId = `${engagementId}:accepted`` — accept is
// a one-shot terminal transition, so a single deterministic key deduplicates retries.
// Copy uses BAL-329 conventions (RETROSPECTIVE names the PERSON "@ company" first
// mention). Dates pre-formatted UTC.
export interface EngagementAcceptedPayload {
  correlationId: string; // `${engagementId}:accepted`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert' (+ admin fan-out)
  actorClientLabel: string; // {actorClient} — retrospective person ("Dana @ Northwind Industrial")
  projectTitle: string; // {title} — subject + body
  acceptedOn: string; // "11 Jul 2026" (pre-formatted, UTC)
  milestonesTotal: number; // {n} — total live milestones
}

// BAL-338 (D7) client requested changes instead of accepting (pending_acceptance →
// active). Fans out to the delivering EXPERT (recipient:'expert' via `expertProfileId`;
// email + in-app — the client's note verbatim + "the {days}-day review window restarts
// when you re-request") and the Balo ADMINS (recipient:'admin_users' fan-out; in-app
// only). `correlationId = `${engagementId}:changes_requested:${changeRequestedAtMs}``
// so a subsequent review cycle legitimately re-notifies while a dispatcher retry of the
// same request is deduped by jobId. Copy uses BAL-329 conventions (RETROSPECTIVE names
// the PERSON "@ company" first mention).
export interface EngagementChangesRequestedPayload {
  correlationId: string; // `${engagementId}:changes_requested:${changeRequestedAtMs}`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert' (+ admin fan-out)
  actorClientLabel: string; // {actorClient} — retrospective person ("Dana @ Northwind Industrial")
  projectTitle: string; // {title} — subject + body + admin in-app body
  note: string; // the client's change note, verbatim — email body
  reviewDays: number; // {days} = AUTO_ACCEPT_DAYS — "the {days}-day review window restarts"
  reviewCycle: number; // {n} — admin in-app body ("review cycle {n}")
}

// BAL-338 (D7) auto-accept: the review window elapsed with no client decision, so the
// D7 sweep closed the project out as delivered (pending_acceptance → completed, method
// 'auto', `accepted_by` NULL). SERVER-ONLY (published from the API sweep, never the web
// route). Fans out to the CLIENT company owner (recipient:'client' via `recipientId`;
// email = VARIANT 3 `AutoAcceptedEmail` verbatim + in-app), the delivering EXPERT
// (recipient:'expert' via `expertProfileId`; email + in-app), and the Balo ADMINS
// (recipient:'admin_users' fan-out; email + in-app — the money trigger, "accepted
// automatically ({days}-day window)"). `correlationId = `${engagementId}:auto_accepted``
// — one-shot terminal. `recipientId` absent for a retainer / owner-miss (the client
// rule skips; expert + admins still fire). Copy uses BAL-329 conventions (PROSPECTIVE
// names the PARTY). Dates pre-formatted UTC.
export interface EngagementAutoAcceptedPayload {
  correlationId: string; // `${engagementId}:auto_accepted`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  recipientId?: string; // client company owner user id → recipient:'client'; absent → client rule skips
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert' (+ admin fan-out)
  clientCompanyName: string; // {Client} — prospective party (email/in-app body)
  expertPartyLabel: string; // {Expert} — prospective party (email subject/body)
  projectTitle: string; // {title} — subject + summary + in-app body
  milestonesTotal: number; // {m} — total live milestones (email summary)
  requestedDate: string; // "4 Jul" (pre-formatted, UTC) — when completion was requested
  autoDate: string; // "11 Jul" (pre-formatted, UTC) — the auto-accept date
  reviewDays: number; // AUTO_ACCEPT_DAYS — the review window length
}

// BAL-338 (D7) T-2 review reminder: a `pending_acceptance` engagement nears its
// auto-accept date and the client hasn't decided — one friendly nudge. SERVER-ONLY
// (published from the API reminder sweep). Targets the CLIENT company owner
// (recipient:'client' via `recipientId`; email = VARIANT 2 `ReviewReminderEmail`
// verbatim + in-app). `correlationId =
// `${engagementId}:review_reminder:${completionRequestedAtMs}`` — the ticket's stated
// idempotency key (engagement id + request timestamp): the daily sweep matching the same
// engagement on both T-2 and T-1 mints the SAME key → one nudge; a genuine re-request
// (fresh `completionRequestedAt`) re-reminds. `recipientId` absent → no-op
// (retainer/no-owner). Copy uses BAL-329 conventions. Dates pre-formatted UTC.
export interface EngagementReviewReminderPayload {
  correlationId: string; // `${engagementId}:review_reminder:${completionRequestedAtMs}`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  recipientId?: string; // client company owner user id → recipient:'client'; absent → no-op
  clientCompanyName: string; // {clientCompany} — prospective party (email body)
  expertPartyLabel: string; // {expertParty} — prospective party (email body)
  projectTitle: string; // {title} — subject + summary + in-app body
  milestonesTotal: number; // {m} — total live milestones (email summary)
  requestedDate: string; // "4 Jul" (pre-formatted, UTC)
  autoDate: string; // "11 Jul" (pre-formatted, UTC) — the auto-accept date
  daysLeft: number; // {daysLeft} — whole days remaining until autoDate (email window block)
}

// BAL-369 / ADR-1038 — a corporate + verified owner PROMOTED their personal
// workspace into a typed COMPANY organization at the onboarding Intent step.
// Published post-commit by the web action ONLY on the fresh `promoted` outcome
// (never on a domain-conflict personal-fallback). `correlationId` is the stable
// `companyId` → BullMQ jobId dedup key, so a retry after a partial failure never
// double-notifies. `ownerUserId` is the promoting owner (subject + recipient). The
// engine rule + template are deferred to S3/BAL-371 — publishing with no rule yet
// is a correct no-op (the `agency.provisioned` precedent). Lives here (not mirrored
// across the api/web files) per this module's "migrate opportunistically" note.
export interface CompanyProvisionedPayload {
  correlationId: string; // = companyId → BullMQ jobId dedup
  companyId: string;
  ownerUserId: string; // the promoting owner (subject + recipient)
}
