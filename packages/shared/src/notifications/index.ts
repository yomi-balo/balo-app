/**
 * Cross-app notification event payloads shared by apps/api (engine) and apps/web (publisher).
 * BAL-290 establishes this shared home; older event payloads still mirror across the two files —
 * migrate opportunistically.
 */

// BAL-386 — a file attachment carried by a notification email. The engine resolves
// the bytes at delivery time (the worker reads from R2 by key), keeping the BullMQ
// payload light. `source: 'r2'` is the only backend today; the discriminant leaves
// room for others without breaking existing carriers.
export interface EmailAttachmentSpec {
  source: 'r2';
  key: string; // R2 object key, e.g. proposals/{proposalId}/client.pdf
  filename: string; // download filename shown to the recipient
}

// BAL-386 — a client member shared a submitted proposal with an external colleague.
// External `email_address` path (the BAL-341 / expert.referral_invited precedent):
// there is no Balo user row to hydrate, so the address rides in the payload.
// `correlationId` = the proposal_share_links row id (dedup + external dispatch key).
// `recipientEmail` + `shareToken` are the deliberate PII-in-queue exception —
// `shareToken` is the RAW ≥256-bit magic-link token and appears ONLY inside the
// emailed URL (never stored, never logged). The attached PDF is already
// client-priced, so the email carries NO expert-facing figures.
export interface ProposalSharedPayload {
  correlationId: string; // = proposal_share_links.id → BullMQ jobId dedup
  recipientEmail: string; // external target (delivery + dedup identity)
  shareToken: string; // raw ≥256-bit token → `${APP_URL}/shared/proposals/{shareToken}`
  sharerName: string; // retrospective person ("Dana Okafor")
  sharerOrgLabel: string; // client company name ("Acme Industrial")
  proposalTitle: string; // email subject/body
  note?: string; // optional sharer note (plain text)
  expiresOn: string; // pre-formatted UTC date ("13 August 2026") — helpful-fact expiry
  attachments: EmailAttachmentSpec[]; // current client PDF
}

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

// BAL-374 onboarding-completion reminder (server-only, published by the API
// repeatable sweep). Recipient is the un-onboarded user (recipient 'self' via
// `userId`; the resolver's existing `payload.userId → data.user` hydration names
// the recipient in the template, falling back to 'there' when name-less).
// SERVER-ONLY — no web-mirror entry, no publishBodySchema arm (mirrors
// engagement.review_reminder). `correlationId = `${userId}:onboarding_reminder:${step}``
// → per-(user, step) BullMQ jobId dedup, so a repeated publish for the same
// (user, step) collapses to one delivery. Defined ONCE here (not inlined in the
// api + web catalogs) per this module's shared-home convention.
export interface OnboardingReminderPayload {
  correlationId: string; // `${userId}:onboarding_reminder:${step}`
  userId: string; // subject + recipient 'self'; resolver hydrates data.user
  cadenceStep: 1 | 2 | 3; // drives the CTA `?step=N` + analytics; NOT shown as copy
}

// BAL-380 (ADR-1040 Lane 3) — credit dormancy reminder. The daily dormancy sweep
// matched a wallet whose rolling `expires_at` sits in the 60d or 30d pre-expiry band —
// a warm, non-countdown nudge that the balance is still there. SERVER-ONLY (published
// by the API sweep). Fans out to the company's MANAGE_BILLING holders (recipient
// 'company_billing_admins' → the resolver hydrates `data.billingUserIds` from
// `companyId`). `window` selects the copy + analytics; `balanceMinor`/`expiresAt` are
// display facts CAPTURED AT SWEEP TIME (carried in the payload, not re-hydrated) so the
// figure is as-of the sweep — matching the engagement-payload precedent. `correlationId
// = `${walletId}:dormancy_reminder:${window}:${expiresAtDate}`` → per-(wallet, window,
// expiry-date) BullMQ jobId dedup; a new dormancy cycle a year later (activity rolled
// `expires_at`) re-reminds because `expiresAtDate` changed. Defined ONCE here to avoid
// Sonar new-code duplication across the api + web catalogs.
export interface CreditDormancyReminderPayload {
  correlationId: string; // `${walletId}:dormancy_reminder:${window}:${expiresAtDate}`
  walletId: string;
  companyId: string; // → resolver hydrates data.billingUserIds (fan-out) + data.company
  window: 60 | 30; // selects copy + analytics
  balanceMinor: number; // display fact, captured at sweep time — "A$347.00"
  expiresAt: string; // ISO — display "12 July 2027"
}

// BAL-383 (ADR-1040) — promo code redeemed. A retrospective, warm milestone
// confirmation addressed to the ACTOR who redeemed (recipient 'self' via `userId`; the
// resolver hydrates `data.user` and the delivery worker greets by name). It is NOT a
// wallet-state notice, so it does NOT use the `company_billing_admins` fan-out (which
// BAL-380 reserves for the impersonal, party-wide dormancy/expiry notices). Published
// from the web redeem Server Action ONLY on a fresh `redeemed` outcome (never on
// `already_redeemed`). `correlationId = promo_redemptions.id` → BullMQ jobId dedup, so a
// retried publish never double-notifies (and `redeem()` is idempotent, so a re-run
// returns the SAME redemption id). `grantedLabel` is pre-formatted (`formatMinorAud`) —
// NO minor units in the payload. Defined ONCE here to avoid the api/web lockstep Sonar
// new-code duplication.
export interface PromoRedeemedPayload {
  correlationId: string; // = promo_redemptions.id → BullMQ jobId dedup
  userId: string; // = redeemedByUserId → recipient 'self' + resolver hydrates data.user
  code: string; // normalized code — email/in-app body ("WELCOME50")
  grantedLabel: string; // "A$50.00" — pre-formatted (formatMinorAud); no minor units in the payload
  companyName: string; // party context — "added to {companyName}"
}

// BAL-380 (ADR-1040 Lane 3) — credit balance expired. The expiry sweep posted the
// zeroing `entry_type='expiry' / reason='dormancy_expiry'` ledger entry, so the wallet
// reached its rolling expiry date. SERVER-ONLY (published by the API sweep). Fans out to
// the company's MANAGE_BILLING holders (recipient 'company_billing_admins'). Soft-toned,
// provisional copy (no balance figure — it is 0 post-expiry). `correlationId` IS the
// ledger idempotency key `dormancy_expiry:${walletId}:${asOf}` — one entry, one notice,
// re-published idempotently on a crash-after-post replay. `expiredMinor` is analytics
// only (never shown in the expired copy). Defined ONCE here (shared-home convention).
export interface CreditBalanceExpiredPayload {
  correlationId: string; // = dormancy_expiry:${walletId}:${asOf} (the ledger idempotency key)
  walletId: string;
  companyId: string; // → fan-out
  expiresAt: string; // ISO — the expiry date reached
  expiredMinor: number; // analytics only; NOT shown in the expired copy
}

// BAL-378 (ADR-1040 Lane 2) — in-session drawdown / settlement notification payloads.
// ALL published SERVER-SIDE (meter driver / endSession service / settlement webhook / nudge
// route) — none has a web mirror or a `publishBodySchema` arm. Defined ONCE here (never
// inlined in the api + web catalogs) to avoid the SonarCloud new-code duplication gate. Each
// carries `correlationId` first (the BullMQ jobId dedup key). `self`/SMS events carry
// `userId` → the resolver's `payload.userId → data.user` hydration makes the `phoneVerifiedAt`
// SMS condition work exactly like `booking-confirmed-sms`; fan-out events carry `companyId` →
// `data.billingUserIds`. The word "overdraft" NEVER appears in any rendered copy (billing
// admins are client-side too) — "extra time" is its warm name.

/**
 * A funded session dropped below the low-runway threshold (meter set `lowWarnedAt` newly).
 * Self-only, in-app. One-shot per session via the deterministic `correlationId`.
 */
export interface SessionLowBalancePayload {
  correlationId: string; // `${sessionId}:low_balance`
  sessionId: string;
  userId: string; // the in-session member (recipient 'self')
  companyId: string;
  minutesRemaining: number;
  balanceMinor: number;
  ratePerMinuteMinor: number;
}

/**
 * A session entered card-backed grace (meter moved active → grace). Self (in-app + SMS) plus
 * an async in-app ping to the company billing admins. One-shot per session.
 */
export interface SessionGraceEnteredPayload {
  correlationId: string; // `${sessionId}:grace_entered`
  sessionId: string;
  userId: string; // the in-session member (recipient 'self' + SMS)
  companyId: string; // → data.billingUserIds (admin ping)
  graceRemainingMinutes: number;
  ceilingRoomMinor: number;
}

/**
 * A session in grace is approaching the wrap (meter set `nearWrapWarnedAt` newly). Self-only,
 * in-app + SMS. One-shot per session.
 */
export interface SessionNearWrapPayload {
  correlationId: string; // `${sessionId}:near_wrap`
  sessionId: string;
  userId: string; // the in-session member (recipient 'self' + SMS)
  companyId: string;
  graceRemainingMinutes: number;
}

/**
 * A session settled — either in-credit at `end` (no charge) OR the `overdraft_settlement`
 * webhook succeeded. Fans out to the company billing admins (email + in-app) as a receipt.
 */
export interface SessionSettledPayload {
  correlationId: string; // `${sessionId}:settled`
  sessionId: string;
  companyId: string; // → data.billingUserIds
  walletId: string;
  overdraftSettledMinor: number; // 0 when in-credit
  expertName: string;
  settledOn: string; // pre-formatted UTC date
}

/**
 * A settlement could not complete — sync hard decline / SCA `requires_action` / an async
 * `payment_failed` after a `processing` accept. Fans out to the billing admins (email +
 * in-app) as dunning. Re-notifiable (the daily dunning sweep) via the attempt-stamped key.
 */
export interface SessionSettlementFailedPayload {
  correlationId: string; // `${sessionId}:settlement_failed:${attemptEpochMs}`
  sessionId: string;
  companyId: string; // → data.billingUserIds
  walletId: string;
  amountMinor: number;
  reason: 'declined' | 'requires_action';
}

/**
 * A member clicked the in-session nudge asking the billing admins to top up. In-app fan-out
 * to the company billing admins. Re-notifiable per click via the now-stamped key.
 */
export interface SessionTopupNudgePayload {
  correlationId: string; // `${sessionId}:topup_nudge:${nowMs}`
  sessionId: string;
  companyId: string; // → data.billingUserIds
  requestedByUserId: string;
  requestedByName: string;
}

// BAL-377 (ADR-1040 Lane 1) — a manual top-up charged successfully and was credited.
// SERVER-ONLY (published from the API Stripe webhook, post-commit — the shipped BAL-382
// webhook is the single authoritative crediting path; this notice is a courtesy receipt).
// Recipient is the PURCHASER (recipient 'self' via `userId`; the resolver's existing
// `payload.userId → data.user` hydration names + targets them). Email + in-app. All
// figures are display facts CAPTURED AT WEBHOOK TIME (carried in the payload, not
// re-hydrated) — matching the dormancy-payload precedent. `correlationId` IS the ledger
// idempotency key `manual_purchase:${piId}` → per-purchase BullMQ jobId dedup, so a
// webhook replay collapses to one receipt. NO fee field (BAL-357): a top-up buys AUD at
// FACE VALUE — the Balo fee lives in the per-minute consume rate, never here; `creditedMinor`
// is the GROSS settled AUD (`balance_transaction.amount`), never a fee-net figure. Defined
// ONCE here to avoid Sonar new-code duplication across the api + web catalogs.
export interface CreditTopupCompletedPayload {
  correlationId: string; // = manual_purchase:${piId} → BullMQ jobId dedup
  userId: string; // the purchaser → recipient 'self'; resolver hydrates data.user
  companyId: string; // context (the wallet's company)
  creditedMinor: number; // GROSS settled AUD credited (balance_transaction.amount)
  chargedCurrency: string; // presentment currency, lowercase (e.g. 'usd', 'aud')
  chargedAmountMinor: number; // presentment minor units (what the card was billed)
  promoGrantedMinor: number; // 0 when no promo redeemed at settlement
  balanceAfterMinor: number; // wallet balance after the credit (+ any promo grant)
  expiresAt: string; // ISO — rolled expiry (rolling-expiry reassurance line)
}

// BAL-391 (ADR-1043) — an action item was assigned to a SIDE of the engagement. One
// event, two conditioned rules keyed on `assigneeParty` (the project.message_posted
// routing precedent): 'client' → recipient:'client' via `recipientId` (the client
// company owner); 'expert' → recipient:'expert' via `expertProfileId` → the resolver
// hydrates data.expert. Email + in-app to the assigned side; NO admin fan-out. Defined
// ONCE here (not inlined in the api + web catalogs) to avoid the SonarCloud new-code
// duplication gate. `correlationId = `${actionItemId}:assigned:${assignedAtMs}`` — a
// reassign re-notifies (fresh ms) while a dispatcher retry dedups by jobId.
// `recipientId` absent (client party, no owner) → the client rule skips gracefully.
// `actionItemBody` is PLAIN TEXT (the template caps length); `actorLabel` is the
// retrospective person who assigned (BAL-329). `dueOn` is pre-formatted UTC.
export interface ActionItemAssignedPayload {
  correlationId: string; // `${actionItemId}:assigned:${assignedAtMs}` → BullMQ jobId dedup
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  actionItemId: string;
  assigneeParty: 'client' | 'expert'; // routes the two conditioned rules
  recipientId?: string; // client company owner user id → recipient:'client'; set when assigneeParty==='client'
  expertProfileId?: string; // → resolver hydrates data.expert → recipient:'expert'; set when assigneeParty==='expert'
  actorLabel: string; // {actor} — retrospective person who assigned ("Dana @ Northwind Industrial")
  projectTitle: string; // subject + body
  actionItemBody: string; // the item text — email/in-app body (plain text)
  dueOn?: string; // "9 Jul 2026" (pre-formatted UTC) when a due date is set — helpful fact
}

// BAL-377 / BAL-381 — a company member WITHOUT MANAGE_BILLING nudged the billing
// holder(s) to top up. Published from the web `nudgeBillingAdminAction` (publishable).
// Fans out to the company's MANAGE_BILLING holders (recipient 'company_billing_admins' →
// the resolver hydrates `data.billingUserIds` from `companyId`). `correlationId` is an
// HOUR-BUCKETED anti-abuse key `topup-nudge:${companyId}:${userId}:${hourBucket}` (NOT a uuid,
// NOT a stable domain id) — a burst of re-nudges inside one hour collapses to a single BullMQ
// jobId (no email-bomb), while a genuine nudge in a later hour still fans out. `requestedByUserId`
// names the nudging member (context/audit; never a recipient — they lack MANAGE_BILLING, so the
// billing fan-out naturally excludes them). Defined ONCE here (shared-home convention).
export interface CreditTopupRequestedPayload {
  correlationId: string; // topup-nudge:{companyId}:{userId}:{hourBucket} — one dispatch/hour
  companyId: string; // → resolver hydrates data.billingUserIds (fan-out) + data.company
  requestedByUserId: string; // the nudging member (context/audit only)
}
