/**
 * Cross-app notification event payloads shared by apps/api (engine) and apps/web (publisher).
 * BAL-290 establishes this shared home; older event payloads still mirror across the two files —
 * migrate opportunistically.
 */

/**
 * BAL-412 (F17) — the settlement shapes are IMPORTED, never re-spelled inline.
 *
 * CLAUDE.md forbids a repeated string union: `credit_settlement_shape` (`enums.ts`) is the source
 * of truth and `MeetingSettlementShape` (`../credit`) is its one dependency-free derivation —
 * already in THIS package, so the import costs no new dependency and cannot drag `@balo/db`
 * anywhere. `PaymentChargedPayload` and `PayoutRecordedPayload` both spelled the four labels out
 * by hand; a fifth shape would have had to be added in two more places, silently.
 *
 * ⚠ Relative, EXTENSION-LESS (memory `reference_balo_shared_no_js_extensions_in_reexports`) —
 * packages/shared is consumed as raw TS by Turbopack, so a `.js` suffix here 404s the web build
 * while every local gate stays green. Opposite rule to `apps/api`.
 */
import type { MeetingSettlementShape } from '../credit';

// ── Preview text (BAL-424) ─────────────────────────────────────────────────────────────
//
// HOISTED HERE FROM `apps/web` BECAUSE BOTH APPS NOW NEED IT AND NEITHER MAY IMPORT THE
// OTHER. `apps/web` derives a message preview at publish time; `apps/api`'s
// `conversation_unread` recheck REBUILDS one at fire time from the newest unread body it
// just read. Two copies would be two truncation rules — and would trip the SonarCloud
// new-code duplication gate. `apps/web`'s `conversation-view-types.ts` and
// `rich-text/plain-text.ts` both delegate here rather than keeping their own copies.

/** Preview length cap — the single source of the 140-char truncation rule. */
export const PREVIEW_MAX_CHARS = 140;

/**
 * Strip HTML tags with a single LINEAR SCAN (no regex) — each `<…>` span becomes a space so
 * word boundaries survive. Deliberately not `/<[^>]*>/g`: that pattern re-scans overlapping
 * start positions and is a SonarCloud S5852 super-linear-regex hotspot. Provably O(n).
 *
 * Input is sanitised/Tiptap HTML, where a literal `>` in text is already an entity, so a raw
 * `>` only ever closes a tag.
 */
export function stripHtmlTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>' && inTag) {
      inTag = false;
      out += ' ';
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

/**
 * Strip tags + decode the handful of entities the editor emits, collapse whitespace runs, and
 * trim. Returns the human-visible text of a fragment of HTML.
 */
export function htmlToPlainText(html: string): string {
  return stripHtmlTags(html)
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate plain text to the preview rule: ≤140 chars, ellipsis on overflow. */
export function previewOfPlainText(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return `${text.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Sanitised-HTML → notification preview, in one hop: the shape both the web publisher and the
 * API recheck need. Returns `''` for an effectively empty body.
 */
export function previewOfHtmlBody(bodyHtml: string): string {
  return previewOfPlainText(htmlToPlainText(bodyHtml));
}

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
/**
 * The three shapes an expert-side milestone scope change can take. Declared ONCE here
 * rather than spelled out as an inline union at each use, so the notification payload
 * below and the web action that builds its `changeSummary` cannot drift apart.
 */
export type MilestoneChangeKind = 'added' | 'edited' | 'removed';

export interface EngagementScopeChangedPayload {
  correlationId: string; // dedup/debounce key — see Decision D
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  milestoneId?: string; // the affected milestone
  recipientId?: string; // client company owner user id → recipient:'client'; absent → client rules skip
  actorExpertLabel: string; // {actorExpert} — retrospective person ("Priya" / "Priya @ CloudPeak")
  projectTitle: string; // {title} — subject + admin in-app body
  changeKind: MilestoneChangeKind;
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
//
// BAL-390 EXTENSION — the accepting client now gets a record of their own acceptance,
// fused with the star-rating ask. Recipient 'self' via the new `userId`, MIRRORING
// `payment.charged`: actor-gets-a-receipt is the house pattern at money moments
// (`credit.topup.completed` and `promo.redeemed` do the same), and acceptance is the
// trigger for the final invoice — so the client should hold written evidence of it
// without having to log in. This DELIBERATELY OVERTURNS BAL-338's "No client recipient
// (they just acted)" ruling, which is the outlier. The auto-accept path legitimately
// differs (recipient 'client' via `recipientId`, because nobody acted) — that asymmetry
// is correct; do not harmonise it.
//
// ⚠ Every BAL-390 field is OPTIONAL so the shipped `accept-project.ts` publisher keeps
// compiling until it is taught to supply them; the new client rule is gated on `userId`
// being present, so the email cannot fire half-populated in the meantime.
export interface EngagementAcceptedPayload {
  correlationId: string; // `${engagementId}:accepted`
  engagementId: string; // CTA / actionUrl → /engagements/{id}
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert' (+ admin fan-out)
  actorClientLabel: string; // {actorClient} — retrospective person ("Dana @ Northwind Industrial")
  projectTitle: string; // {title} — subject + body
  acceptedOn: string; // "11 Jul 2026" (pre-formatted, UTC)
  milestonesTotal: number; // {n} — total live milestones
  userId?: string; // BAL-390: the ACCEPTING member → recipient 'self'; absent ⇒ the client rule skips
  clientCompanyName?: string; // BAL-390: {Client} — prospective party (email body)
  expertPartyLabel?: string; // BAL-390: {Expert} — prospective party (email body)
  reviewToken?: string; // BAL-390: RAW review-invite token; absent ⇒ no star block
  // BAL-390: this member has ALREADY rated this expert on this engagement, so the email
  // may thank them for it. ⚠ NOT inferable from `reviewToken === undefined`: the token
  // is also absent when the mint FAILED, and a mint failure must never break an accept,
  // so the token's absence means "no star block", never "they rated". Only the publisher
  // knows which of the two happened — it says so here.
  alreadyRated?: boolean;
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
//
// BAL-390 EXTENSION — `reviewToken` fuses the star-rating ask into THIS existing email
// (D7). No second project email is added on the auto path: `AutoAcceptedEmail` renders
// the star row after its green window block when the token is present, and omits the
// block ENTIRELY (not greyed — gone) when it is absent, which is what "already rated"
// looks like. The rule for this event is UNCHANGED.
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
  reviewToken?: string; // BAL-390: RAW review-invite token; absent ⇒ already rated ⇒ no review block
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

// BAL-379 (ADR-1040) — a between-session auto-top-up reload was CHARGED and CREDITED. The
// wallet's resting balance finalized below the configured threshold when a session settled,
// so the reload chunk was charged on the company's stored off-session mandate and the
// `payment_intent.succeeded` webhook credited it. SERVER-ONLY (published from the API Stripe
// webhook post-commit — no web mirror, no `publishBodySchema` arm). Fans out to the company's
// MANAGE_BILLING holders (recipient 'company_billing_admins' → the resolver hydrates
// `data.billingUserIds` from `companyId`). `correlationId` IS the ledger idempotency key
// `auto_topup:{walletId}:{triggeringEntryId}` → per-crossing BullMQ jobId dedup, so a replayed
// webhook never re-notifies. Every amount is the AUD reload FACE value (no fee/margin/overdraft
// — fee-concealment posture). Defined ONCE here (shared-home convention — avoids the Sonar
// new-code duplication gate across the api + web catalogs).
export interface CreditAutoTopupExecutedPayload {
  correlationId: string; // = auto_topup:{walletId}:{triggeringEntryId} (ledger key) → jobId dedup
  walletId: string;
  companyId: string; // → resolver hydrates data.billingUserIds (fan-out)
  reloadedMinor: number; // AUD reload FACE value (balance_transaction.amount); no fee/margin
  balanceAfterMinor: number; // wallet balance after the reload (the client's own balance)
  expiresAt: string; // ISO rolled expiry (rolling-expiry reassurance)
}

// BAL-379 (ADR-1040) — a between-session auto-top-up reload charge could NOT complete
// (SCA/`requires_action` or a hard decline). SERVER-ONLY. Fans out to the company's
// MANAGE_BILLING holders. NO receivable, NO account hold — an auto-top-up failure is not
// money owed; the company keeps spending its existing balance. Calm, actionable copy ("update
// the card to keep auto-top-up on"), never dunning/countdown. `correlationId` is the ledger
// key with a `:failed` suffix — the SYNC engine and the ASYNC `payment_intent.payment_failed`
// belt publish with the SAME correlationId ⇒ one notice per crossing (BullMQ jobId dedup).
// `attemptedMinor` is the AUD reload face value we tried to charge. Defined ONCE here.
export interface CreditAutoTopupFailedPayload {
  correlationId: string; // = auto_topup:{walletId}:{triggeringEntryId}:failed → jobId dedup
  walletId: string;
  companyId: string; // → fan-out
  reason: 'declined' | 'requires_action';
  attemptedMinor: number; // AUD reload face value we tried to charge (no trigger-balance in copy)
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
// event, two conditioned rules keyed on `assigneeParty` (the conversation.message_posted
// routing precedent — renamed off `project.` by BAL-424): 'client' → recipient:'client'
// via `recipientId` (the client
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

// BAL-399 (ADR-1040 / ADR-1043) — Case consultation billing-slice notifications. Both are
// SERVER-ONLY (published from `finalizeBilling`, gated on the payout-record `created` flag so each
// fires EXACTLY ONCE per session). Defined ONCE here to avoid the api/web lockstep Sonar new-code
// duplication (memory `reference_notification_event_dup_shared_home`). Fee concealment holds at
// the template layer too: `payment.charged` carries ONLY the client all-in (no expert figure /
// margin); `payout.recorded` carries ONLY the expert's own earnings (no client charge / markup).

/**
 * A consultation's billing finalized and the CLIENT was charged. Recipient 'self' = the acting
 * in-session member (`userId = initiatingMemberId`) — a PERSONAL consultation receipt, DISTINCT
 * from the billing-admin `session.settled` fan-out (a person who is both simply gets both; no
 * suppression, Owner Decision O1). Email + in-app. `amountAudMinor` is the all-in charge
 * (connectedMinutes × client rate) — NO expert rate / accrual / fee anywhere.
 */
export interface PaymentChargedPayload {
  correlationId: string; // `${sessionId}:payment_charged` → BullMQ jobId dedup
  userId: string; // = initiatingMemberId → recipient 'self'; resolver hydrates data.user
  companyId: string; // context (the wallet's company)
  sessionId: string;
  amountAudMinor: number; // connectedMinutes × clientRateMinorPerMinute (the all-in charge)
  durationMinutes: number;
  expertName: string; // display only (resolveExpertName)
  chargedOn: string; // pre-formatted UTC date
  // ── BAL-412 (ADR-1044 §7) additions — OPTIONAL, so the shipped `live_capture` path (which
  // never sets these) is unaffected. Durations/labels, never a SECOND figure — fee-safe.
  /** How the presence settlement resolved. Present only on a presence-settled session. */
  settlementShape?: MeetingSettlementShape;
  /** Minutes ACTUALLY delivered, PRE-floor. */
  actualMinutes?: number;
  /** The floor in force at settlement, whole minutes. */
  billingFloorMinutes?: number;
}

/**
 * A consultation's expert payout obligation was booked. Recipient 'expert' via
 * `expertProfileId` → the resolver hydrates `data.expert` → the dispatcher resolves the expert's
 * user id. No expert-facing payout notice existed before BAL-399. Email + in-app. `amountAudMinor`
 * is the expert's OWN earnings (= expertAccruedMinor) — NO client charge / markup / margin.
 */
export interface PayoutRecordedPayload {
  correlationId: string; // `${sessionId}:payout_recorded` → BullMQ jobId dedup
  expertProfileId: string; // → data.expert → recipient 'expert'
  sessionId: string;
  amountAudMinor: number; // = expertAccruedMinor (own earnings)
  durationMinutes: number;
  recordedOn: string; // pre-formatted UTC date
  // ── BAL-412 (ADR-1044 §7) additions — OPTIONAL, mirroring PaymentChargedPayload's.
  settlementShape?: MeetingSettlementShape;
  actualMinutes?: number;
  billingFloorMinutes?: number;
}

/**
 * BAL-412 (ADR-1044 §7) — the expert never joined. Nothing was charged and the credit hold is
 * released in full. TWO conditioned rules on ONE event (the `recap.ready` pattern): the acting
 * member (recipient 'self', APOLOGETIC — Balo failed them) and the delivering expert (recipient
 * 'expert' via `expertProfileId`, FACTUAL — no penalty in v1, but they should know it was
 * recorded). SERVER-ONLY — published exclusively by `apps/api`'s presence-settlement service
 * (`finalizeBilling`, gated on `settlementShape === 'missed_call'`), never from apps/web, so it
 * has NO `publishBodySchema` arm; adding one would be a `StraySchemaArm` and fail `tsc`.
 *
 * ⚠ CARRIES NO FIGURE AT ALL — nothing was charged, so concealment is trivial (both templates
 * read the same payload safely).
 *
 * ⚠ `abandoned_wait` publishes NOTHING (D2) — see `finalize-billing.ts`'s gate. This event is
 * ONLY for `missed_call` (the expert never joined at all).
 */
export interface SessionMissedCallPayload {
  correlationId: string; // `${sessionId}:missed_call` → BullMQ jobId dedup
  sessionId: string;
  meetingId: string;
  userId: string; // the acting member → recipient 'self'; resolver hydrates data.user
  companyId: string;
  expertProfileId: string; // → data.expert → recipient 'expert'
  expertName: string;
  scheduledOn: string; // pre-formatted UTC date, matching the credit-email convention
}

// BAL-387 (ADR-1013 + ADR-1043) — a transcript recap is ready. SERVER-ONLY (published from the
// pipeline worker post-`markRecapPublished`; no web mirror, no `publishBodySchema` arm). One
// event, two conditioned rules keyed on recipient presence (the two-party `engagement.cancelled`
// pattern): the CLIENT company owner (recipient:'client' via `recipientId`; skips gracefully when
// absent) + the delivering EXPERT (recipient:'expert' via `expertProfileId` → the resolver
// hydrates data.expert). Email + in-app to each; NO admin fan-out. Defined ONCE here to avoid the
// SonarCloud new-code duplication gate. `correlationId = `${transcriptId}:recap_ready`` → BullMQ
// jobId dedup (a second layer atop the `recap_ready_published_at` stage gate). LENS-SAFE: carries
// NO money at all (the money block is BAL-399's separate `payment.charged` / `payout.recorded`),
// so concealment is trivial. `summaryHeadline` is a short, plain-text, party-safe one-liner (no
// fee content); `recordingRef` is NULLABLE/deferred (no live capture producer).
export interface RecapReadyPayload {
  correlationId: string; // `${transcriptId}:recap_ready` → BullMQ jobId dedup
  engagementId: string; // context for the resolver / rules — NOT the CTA (BAL-388: the CTA is the recap)
  transcriptId: string;
  meetingId: string; // BAL-418: REQUIRED — transcripts.meeting_id is a NOT NULL FK → meetings.id
  recipientId?: string; // client company owner user id → recipient:'client'; absent → client rule skips
  expertProfileId: string; // → resolver hydrates data.expert → recipient:'expert'
  actionItemCount: number; // display fact (lens-safe)
  summaryHeadline?: string; // short plain-text one-liner (shared meeting context — no fee content)
  recordingRef?: string | null; // NULLABLE/deferred — no producer
}

/**
 * BAL-390 — the star-rating nudge (+24h / +7d off the terminal anchor).
 *
 * ⚠ DELIBERATELY NOT `engagement.review_reminder`: that key is BAL-338/D7's project
 * ACCEPTANCE nudge ("review the delivered work before it auto-accepts") and carries
 * `EngagementReviewReminderPayload`. Different meaning, different payload, different
 * template (`engagement-review-reminder-client`). Do NOT consolidate them.
 *
 * SERVER-ONLY (published by the API sweep). EMAIL ONLY, recipient 'self' via `userId`
 * (the `onboarding.reminder` shape) — the ask IS the in-email star row, and an in-app
 * copy would carry neither stars nor token.
 *
 * ⚠ PUBLISHED ONCE PER RECIPIENT, NEVER FANNED OUT. `reviewToken` is per-reviewer and
 * the dispatcher shares ONE payload across a whole fan-out, so a fan-out recipient kind
 * would put one person's magic-link token in everyone else's email. That is a
 * correctness constraint, not a style preference.
 *
 * `reviewToken` is the RAW token: the deliberate secret-in-queue exception, exactly the
 * `ProposalSharedPayload.shareToken` precedent. It appears ONLY inside the emailed URL —
 * never stored, never logged.
 */
export interface ReviewReminderPayload {
  correlationId: string; // `${engagementId}:${userId}:review_nudge:${step}`
  engagementId: string; // CTA target → `${APP_URL}/review/{reviewToken}`
  userId: string; // the reviewer → recipient 'self'; the resolver hydrates data.user
  reviewToken: string; // RAW ≥256-bit token → `${APP_URL}/review/{reviewToken}?r={1..5}`
  cadenceStep: 1 | 2; // drives the copy; there is no step 3 (window math forbids one)
  engagementKind: 'project' | 'case';
  engagementTitle: string;
  expertPartyLabel: string; // retrospective attribution (BAL-329)
  clientCompanyName: string;
  anchorDate: string; // pre-formatted UTC, "4 Jul"
  consultationCount?: number; // OPTIONAL — feeds step 2's regrounding. No producer today.
  // CASE ONLY — `case_engagements.close_reason`. Step 2's regrounding paragraph states
  // WHY the case closed, so it must not assert "things went quiet" over a deliberate
  // `resolved` close (`CaseClosedEmail` already branches this way; the nudge now
  // matches). OPTIONAL by design: the project arm never has one, and a job enqueued
  // before this field existed still validates — the template falls back to the
  // reason-blind wording when it is absent.
  closeReason?: 'resolved' | 'auto_inactive';
}

/**
 * BAL-390 (D4) — a case was closed; the fused close-confirmation + rating email.
 *
 * ⚠ LIVE AS OF BAL-388. The recap's `resolveCaseAction` is the FIRST and (today) only
 * publisher: a `@balo/db` repository structurally cannot publish, so `close()` gets its
 * publish line at the caller's layer. The `auto_inactive` arm is still unpublished
 * (BAL-420's sweep owns it). Do not describe this event as inert.
 *
 * ⚠ THIS EVENT IS **PUBLISHABLE**, NOT SERVER-ONLY. BAL-421's caller is a web Server
 * Action, which publishes over HTTP → `apps/api/src/routes/notifications/schema.ts`.
 * Adding it to `ServerOnlyNotificationEvent` would leave it with no Zod arm and make
 * BAL-421 physically unable to publish it.
 *
 * `reviewToken` ABSENT ⇒ already rated ⇒ the template omits the review block ENTIRELY
 * (not greyed — gone), replaced by one warm line.
 */
export interface EngagementCaseClosedPayload {
  correlationId: string; // `${engagementId}:case_closed` → BullMQ jobId dedup
  engagementId: string; // context for the resolver / rules — NOT the CTA (see meetingId)
  /**
   * ⚠ THE CTA / actionUrl SUBJECT (BAL-388). `/engagements/{id}` 404s BY CONSTRUCTION for a
   * CASE — `engagements/[id]`'s loader filters `engagement_type = 'project'` — so both the
   * email button and the in-app deep link point at `/meetings/{meetingId}` instead. OPTIONAL
   * because a future auto-close sweep may have no anchoring meeting; when it is absent the
   * templates render NO link at all rather than a dead one.
   */
  meetingId?: string;
  recipientId?: string; // client-side reviewer → recipient 'client'; absent ⇒ the rule skips
  expertProfileId: string; // → resolver hydrates data.expert (context; no expert rule today)
  clientCompanyName: string; // {Client} — prospective party
  expertPartyLabel: string; // {Expert} — prospective party (BAL-329)
  caseTitle: string; // subject + body + in-app body
  closedDate: string; // pre-formatted UTC
  closeReason: 'resolved' | 'auto_inactive';
  consultationCount?: number; // OPTIONAL — regrounding copy; BAL-420/421 must supply a source
  reviewToken?: string; // RAW review-invite token; absent ⇒ already rated ⇒ no review block
}

/**
 * BAL-408 / ADR-1044 — a guest was invited to a meeting.
 *
 * EXTERNAL `email_address` path (the `expert.referral_invited` / `proposal.shared`
 * precedent): there is no Balo user row to hydrate, so the address rides in the payload.
 * `recipientEmail` + `joinToken` are the deliberate PII-in-queue exception — `joinToken` is
 * the RAW ≥256-bit magic-link token and appears ONLY inside the emailed URL
 * (`${APP_URL}/join/{joinToken}`); it is never stored, never logged, never recoverable.
 *
 * ⚠ SERVER-ONLY: published by `apps/api`'s invite service, never through the internal
 * `/notifications/publish` route — so it has NO `publishBodySchema` arm (adding one is a
 * `StraySchemaArm` and fails `tsc`) and NO mirror in `apps/web/src/lib/notifications/types.ts`.
 *
 * ⚠ PUBLISHED ONCE PER GUEST, NEVER FANNED OUT. `joinToken` is per-guest and the dispatcher
 * shares ONE payload across a whole fan-out, so a fan-out recipient kind would put one
 * person's join credential in everyone else's email. A correctness constraint, not a style
 * preference — the same one `ReviewReminderPayload` carries.
 *
 * ⚠⚠ NO BILLING LINE, EVER. A guest never sees the rate, the duration price, the balance or
 * any money figure. The AC is "billing unaffected — per-minute of expert time, never
 * per-seat", and the email is where a stray figure would leak it to an outsider.
 *
 * ⚠ COUNTERPARTY CONCEALMENT APPLIES HERE TOO: names cross the party boundary, EMAIL
 * ADDRESSES NEVER. Hence `inviterName` / `inviterOrgLabel` are NAME/ORG labels and there is
 * deliberately no counterparty email field of any kind.
 *
 * ⚠⚠ `correlationId` IS THE ROW ID AND IS **NOT** AN ANTI-ABUSE KEY — READ THIS BEFORE
 * "HARMONISING" IT WITH `CreditTopupRequestedPayload`'s HOUR BUCKET.
 * That payload buckets on `{companyId}:{userId}:{hourBucket}` because a re-nudge is
 * CONTENT-IDENTICAL: collapsing a burst loses nothing. THIS email is not — every invite
 * carries a DIFFERENT `joinToken`, and the previous one has just been revoked. Bucketing it
 * would make credential delivery non-deterministic (jobs are retained only
 * `removeOnComplete: { count: 100 }` deep, so the collision is a coin flip), and the
 * failure mode is a guest holding a dead link with no resend affordance.
 *
 * The amplification this would have been reaching for — invite → remove → invite emits two
 * emails per cycle to any address the actor names, unbounded because the
 * `(meeting, party, email)` unique is PARTIAL and `revoke` vacates it — is bounded instead
 * at the ROUTE, by the Redis fixed windows in `routes/meetings/guests.ts`. That is a hard
 * bound rather than a best-effort collapse, it refuses LOUDLY with a `429` instead of
 * silently swallowing a credential, and it also covers the removal half transitively (a
 * removal email can fire at most once per guest ROW — `revoke` is idempotent and publishes
 * nothing on the second call — and rows only come from the rate-limited invite route).
 */
export interface MeetingGuestInvitedPayload {
  correlationId: string; // = meeting_guests.id → BullMQ jobId dedup (exactly-once per guest)
  recipientEmail: string; // the invited external address (delivery + dedup identity)
  joinToken: string; // RAW ≥256-bit token → `${APP_URL}/join/{joinToken}`
  guestName?: string; // absent ⇒ the template greets generically, never with the local part
  inviterName: string; // retrospective PERSON ("Dana")
  inviterOrgLabel: string; // "Northwind Industrial" / "CloudPeak" — the org, on first mention
  meetingTitle: string; // what the meeting is ABOUT — ⚠ never a money figure
  scheduledStartIso: string;
  scheduledEndIso: string;
  accessScope: 'meeting' | 'engagement'; // drives the disclosure paragraph
  expiresOn: string; // pre-formatted UTC date — helpful-fact framing, never a countdown
}

/**
 * BAL-408 — FYI to the guest's OWN party that the meeting roster changed. In-app only: it
 * is a low-signal roster change, and an email per added colleague would be noise.
 *
 * ⚠ `recipientUserIds` IS RESOLVED BY THE PUBLISHER, NOT BY THE ENGINE. The invite service
 * already holds the party and its members; making `engine/resolver.ts` work it out would
 * put a `meeting_guests` read inside the notification engine, which is exactly the coupling
 * the engine exists to avoid. The dispatcher's new `meeting_party_participants` fan-out kind
 * reads this array and nothing else.
 *
 * ⚠ `guestDisplayName` IS A NAME ONLY — never the guest's email address. This event goes to
 * the guest's OWN party, but the field is still name-only so that a future cross-party
 * variant cannot be created by changing one rule line.
 */
export interface MeetingGuestAddedPayload {
  correlationId: string; // `${meetingId}:${guestId}` — one FYI per added guest
  recipientUserIds: string[]; // publisher-resolved same-party members → fan-out
  guestDisplayName: string; // NAME only — ⚠ never the guest's email
  meetingTitle: string;
  scheduledStartIso: string;
}

/**
 * BAL-408 — a guest's access was revoked. Email to THAT PERSON ONLY.
 *
 * ⚠ THE CALENDAR HALF OF THE AC IS DEFERRED, AND THIS EVENT IS THE WHOLE OF THE SHIPPED
 * REMOVAL NOTICE. The AC line "Removing a guest … sends `METHOD:CANCEL` to that person only"
 * cannot be satisfied: no meeting has a calendar event to cancel. Verified against this
 * checkout — no `SEQUENCE` / `METHOD:CANCEL` / `VEVENT` literal exists anywhere in `apps/**`
 * or `packages/**`, no `ics` / `ical-generator` / `node-ical` dependency exists, and
 * `lib/cronofy.ts` exports only the two client getters (all calendar traffic is READ:
 * free/busy → the availability cache). BAL-129 provisions a Daily room and writes no
 * calendar event. A NEW TICKET owns meeting calendar-event writing + `SEQUENCE` fan-out, as
 * a shared dependency of BAL-408/409/410/411 — see the plan's §14.2. Revocation itself IS
 * immediate and total: every read path re-checks `revoked_at IS NULL`.
 */
export interface MeetingGuestRemovedPayload {
  correlationId: string; // = meeting_guests.id (stable: one removal per guest row)
  recipientEmail: string; // that person, and only that person
  guestName?: string;
  meetingTitle: string;
  scheduledStartIso: string;
}

/**
 * BAL-436 — a host re-sent the join link to an ADMITTED guest who never arrived. Email to
 * THAT PERSON ONLY, and it carries a freshly ROTATED credential.
 *
 * ⚠⚠ NO `inviterName` / `inviterOrgLabel` / `accessScope`, UNLIKE THE INVITE. This row was
 * created by the RECIPIENT themselves (a `link` knock), so there is no inviter to attribute
 * — naming the host who admitted them would be inventing an inviter relationship that does
 * not exist. And `accessScope` on a `link` row is `meeting` by construction, chosen by
 * nobody, so a disclosure paragraph about it would be describing a grant no one negotiated.
 *
 * ⚠ NO BILLING LINE, EVER — the same absolute rule as {@link MeetingGuestInvitedPayload}.
 * The reader is an outsider who is not the payer.
 */
export interface MeetingGuestLinkResentPayload {
  /**
   * ⚠⚠ **NOT `meeting_guests.id`** — READ THIS BEFORE "HARMONISING" IT WITH
   * {@link MeetingGuestInvitedPayload}. That payload's `correlationId` IS the row id and is
   * used as a BullMQ jobId dedup key ("exactly-once per guest"). A RE-SEND happens on the
   * SAME row, so reusing the row id would collide with the original invite's job and be
   * SILENTLY SWALLOWED — producing exactly the failure that docblock warns about, a guest
   * holding a dead link with a re-send affordance that appears to work and sends nothing.
   *
   * It is the first 16 hex characters of the NEWLY MINTED token's SHA-256 hash: unique per
   * rotation, deterministic for a retry of the same rotation, and never the raw token.
   */
  correlationId: string;
  recipientEmail: string; // that person, and only that person
  joinToken: string; // RAW — the freshly rotated credential. ⚠ Never logged, never persisted.
  guestName?: string; // absent ⇒ the template greets generically, never with the local part
  meetingTitle: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  expiresOn: string; // pre-formatted UTC date — helpful-fact framing, never a countdown
}

// ── BAL-424 conversation events ────────────────────────────────────────────────────────
//
// ⚠ DECLARED ONCE, HERE. `apps/api/src/notifications/events.ts` and
// `apps/web/src/lib/notifications/types.ts` both IMPORT these — inlining them into both
// catalogs is what the SonarCloud new-code duplication gate exists to catch.
//
// ⚠ THE ANCHOR IS THE SEAM. `conversationId` + `(contextType, contextId)` is what makes one
// event serve a project relationship AND a case: `projectRequestId` is now OPTIONAL because
// a Case has no request, and `engagementId` carries the other arm.

/**
 * BAL-424 — a message was posted to a conversation. Cross-cutting: the anchor is the seam.
 *
 * Renamed from `project.message_posted` when messaging was re-anchored off
 * `request_expert_relationships` — a `project.` prefix on an event that fires for a Case
 * would make `notification_log.event`, every Axiom query and every future rule condition
 * read `project.*` for a message with no project.
 */
export interface ConversationMessagePostedPayload {
  correlationId: string; // = message id — dedup per message (dispatcher jobId)
  conversationId: string;
  contextType: 'relationship' | 'engagement';
  contextId: string;
  /** Thread title for the body — the request title, or the case title. */
  title: string;
  senderName: string;
  recipientRole: 'client' | 'expert'; // rule condition routes on this
  recipientId?: string; // set when recipientRole==='client' → dispatcher 'client' path
  expertProfileId?: string; // set when recipientRole==='expert' → resolver hydrates data.expert
  preview: string; // plain-text snippet ≤140
  /** Present ONLY on the `relationship` arm, so the in-app actionUrl can deep-link the request. */
  projectRequestId?: string;
  /** Present ONLY on the `engagement` arm — equals `contextId`; kept explicit for the template. */
  engagementId?: string;
  /** True when the message was sent from the in-call panel. Analytics + copy, never routing. */
  sentDuringMeeting: boolean;
}

/**
 * BAL-424 — a file was shared into a conversation. Same anchor fields as
 * {@link ConversationMessagePostedPayload}, with `fileName` in place of `preview`.
 */
export interface ConversationFileSharedPayload {
  correlationId: string; // = file id — dedup per share
  conversationId: string;
  contextType: 'relationship' | 'engagement';
  contextId: string;
  title: string;
  senderName: string;
  recipientRole: 'client' | 'expert';
  recipientId?: string;
  expertProfileId?: string;
  fileName: string;
  projectRequestId?: string;
  engagementId?: string;
}

/**
 * BAL-424 — the 10-minute debounced unread digest is due.
 *
 * ⚠ IT COVERS MESSAGES **AND** FILE SHARES ON ONE PROMISE (owner ruling, 2026-08-11). Both
 * `conversation.message_posted` and `conversation.file_shared` schedule this event on the
 * SAME dedupe key, so a message plus a file inside one window folds into ONE email. It is
 * named `unread_digest_due`, not `unread_messages_due`, for exactly that reason.
 *
 * ⚠ SERVER-ONLY. It is published EXCLUSIVELY by the BAL-420 dispatch tick, never through
 * `/notifications/publish`, so it belongs in `ServerOnlyNotificationEvent` and MUST NOT get a
 * `publishBodySchema` arm — one would be a `StraySchemaArm` and fail `tsc`.
 *
 * ⚠ `recipientUserId` IS RESOLVED AT SCHEDULE TIME AND STORED. The fire-time recheck reads
 * `conversation_read_states` by (conversation, user), and an `expertProfileId` cannot be
 * resolved to a user inside a recheck without a second hydration. The two counts, `preview`,
 * `fileName` and `latestActivityAtIso` are all REBUILT by the recheck from live state — the
 * stored values are only the default answer if the guard is ever removed.
 *
 * ⚠ THE TWO COUNTS ARE SEPARATE, NOT SUMMED. The subject line differs materially between
 * "3 new messages", "a new file" and "3 new messages and a file", and a single `unreadCount`
 * cannot express the third. Mirrors `unreadSummaryFor`'s return shape exactly.
 *
 * ⚠ `senderName` IS THE ONLY COUNTERPARTY IDENTITY THIS PAYLOAD CARRIES, and it is a NAME.
 * ADR-1044's concealment rule — names cross the party boundary, email addresses never — is
 * why there is no address field of any kind here.
 */
export interface ConversationUnreadDigestDuePayload {
  /**
   * ⚠ AN OCCURRENCE ID, MINTED PER PROMISE (`randomUUID`) — NOT a value derived from
   * (conversation, recipient). `publisher.publish` derives the BullMQ jobId from it and
   * completed jobs are retained `{ count: 100 }` on one shared queue, so a value stable per
   * PAIR would make every digest after the first a silent `queue.add` no-op WHILE the row is
   * marked `published`. Stable across the recheck's REBUILD of one promise (the guard spreads
   * the stored payload); unique across promises. Full argument in
   * `scheduling/conversation-unread.ts`.
   */
  correlationId: string;
  conversationId: string;
  contextType: 'relationship' | 'engagement';
  contextId: string;
  recipientUserId: string;
  recipientRole: 'client' | 'expert';
  title: string;
  /**
   * Author of the newest unread activity — REBUILT by the fire-time guard, never inherited
   * from schedule time (by fire time the window may have coalesced a DIFFERENT author).
   * `null` when the digest spans MORE THAN ONE sender: naming only the newest would
   * misattribute the rest, so the template says "your conversation" instead of a name.
   */
  senderName: string | null;
  unreadMessageCount: number;
  unreadFileCount: number;
  /**
   * Newest unread MESSAGE preview. Absent on a file-only exchange — the guard CLEARS the leg
   * that no longer applies rather than letting a stale schedule-time value survive its
   * rebuild. ⚠ The TEMPLATE branches on the COUNTS, not on this field's presence.
   */
  preview?: string;
  /** Newest unread FILE name. Absent when the newest unread activity is a message. */
  fileName?: string;
  /** max(newest unread message, newest unread file) — the `latestInboundActivityAt` rule. */
  latestActivityAtIso: string;
  projectRequestId?: string;
  engagementId?: string;
}

// ── BAL-134 — the two meeting-absence promises (§6) ────────────────────────────────────
//
// ⚠ THE PAYLOADS LIVE IN THEIR OWN MODULE AND ARE RE-EXPORTED HERE, not restated: a payload
// declared twice trips the SonarCloud duplication gate and lets the two copies drift while both
// compile (memory `reference_notification_event_dup_shared_home`). ⚠ EXTENSIONLESS relative
// specifier — see the corrected note in `../meetings/index.ts`; a `.js` here 404s Turbopack.
export * from './meeting-absence';

// ── BAL-414 — the two searchability-transition promises (D1/D2) ────────────────────────
//
// ⚠ EXTENSIONLESS relative specifier — same rule as every other import in this file.
import type { ExpertChecklistItemKey } from '../experts';

/**
 * BAL-414 (D1/D2) — the expert stopped meeting the six-item checklist and has been removed
 * from expert search AND from their public profile URL. Recipient 'expert' via
 * `expertProfileId` (the `calendar.auth_error` resolution). Email + in-app.
 *
 * ⚠ NOT PUBLISHED FOR A CALENDAR CREDENTIAL BREAK. That case rides the strengthened
 * `calendar-reconnect-required` email instead (D2, "one email per underlying cause"); the
 * suppression lives at the `flipToReconnectRequired` call site, not in a rule condition.
 *
 * `correlationId` IS the `audit_events` row id minted by the conditional compare-and-set that
 * performed this transition. One transition ⇒ one uuid ⇒ a deterministic BullMQ jobId; a
 * genuine later regression mints a new row and legitimately re-notifies. Do NOT use
 * `expertProfileId` — that would silence every regression after the first.
 */
export interface ExpertSearchabilityLostPayload {
  correlationId: string; // = audit_events.id → BullMQ jobId dedup
  expertProfileId: string; // → resolver hydrates data.expert → recipient 'expert'
  failingItems: ExpertChecklistItemKey[]; // ordered; the template lists what to fix
}

/**
 * BAL-414 (D2) — the expert completed the checklist again and is back in search. IN-APP ONLY,
 * both directions of cause: a flapping calendar connection must never generate email churn.
 * `correlationId` is the `audit_events` row id, as above.
 */
export interface ExpertSearchabilityRestoredPayload {
  correlationId: string; // = audit_events.id → BullMQ jobId dedup
  expertProfileId: string; // → resolver hydrates data.expert → recipient 'expert'
}

/**
 * BAL-400 — a consultation was booked into a case. Published by the web booking Server Action
 * AFTER `POST /meetings` returns 201, so a case with no meeting never notifies anyone.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never. No field here is or contains an email address.
 * ⚠ FEE CONCEALMENT: no rate, no total, no estimate. There is none to leak (D4c).
 */
export interface BookingConfirmedPayload {
  /** `${meetingId}` — BullMQ jobId dedup (publisher.ts:16). Makes an idempotent retry publish once. */
  correlationId: string;
  meetingId: string;
  engagementId: string;
  /** The booking client's user id → recipient 'client'. Absent ⇒ the client rule skips. */
  recipientId?: string;
  /** → recipient 'expert' (resolver hydrates data.expert). */
  expertProfileId: string;
  /** Prospective copy names the PARTY (CLAUDE.md). */
  clientCompanyName: string;
  expertPartyLabel: string;
  caseTitle: string;
  /** True when this booking opened the case; false when it attached to an existing one. */
  isNewCase: boolean;
  /** Count BEFORE this booking — lets the expert template reference prior consultations on an attach. */
  priorConsultationCount: number;
  scheduledStartIso: string;
  durationMinutes: number;
  /** `/join/m/{meetingId}` — the member route. NEVER `meetings.join_url` (raw Daily). */
  joinPath: string;
  /** False ⇒ the Daily room is not up yet; templates must not promise a live link. */
  provisioned: boolean;
  guestCount: number;
}

/**
 * BAL-409 — a booked consultation was moved by the CLIENT. Published by the case-surface
 * Server Action AFTER the reschedule route returns 200, so nothing notifies on a failed move.
 *
 * ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3): names cross the party boundary, addresses
 * never. No field here is or contains an email address.
 * ⚠ FEE CONCEALMENT: no rate, no total, no hold. A reschedule moves no money.
 */
export interface BookingRescheduledPayload {
  /** `${meetingId}:${scheduledStartIso}` — the BullMQ jobId dedup key. NOT the bare meetingId:
   *  a SECOND reschedule of the same meeting must notify again, and a bare id would collide with
   *  the first publish and be SILENTLY SWALLOWED. Two moves to the same instant collapse, which
   *  is correct. */
  correlationId: string;
  meetingId: string;
  engagementId: string;
  /** The rescheduling client's user id → recipient 'client'. Absent ⇒ the client rule skips. */
  recipientId?: string;
  /** → recipient 'expert'; the resolver hydrates `data.expert` off this field name. */
  expertProfileId: string;
  /** Prospective copy names the PARTY (CLAUDE.md). */
  clientCompanyName: string;
  expertPartyLabel: string;
  caseTitle: string;
  previousScheduledStartIso: string;
  scheduledStartIso: string;
  durationMinutes: number;
  /**
   * ⚠ NO `joinPath` ON THIS EVENT, DELIBERATELY — and it is not an omission to "fix" later.
   * A reschedule REUSES the same `meetings` row and the same Daily room (ADR-1044 amendment
   * 2026-08-08), so the join link is byte-identical before and after; both templates say
   * "same link" and link the CASE, which is the right destination for a meeting that is still
   * in the future. Carrying a join path that four registration files validate and no template
   * renders is dead weight that reads as intentional to the next person.
   * `booking.confirmed` keeps its `joinPath` — that one IS rendered.
   */
  /** `'client'` today; BAL-411 added `'expert'` (accepting a reschedule proposal). Present from
   *  day one so the template need not change SHAPE — it does change COPY, branching on this
   *  field: see `booking-rescheduled.tsx`'s `initiatedBy` prop. */
  initiatedBy: 'client' | 'expert';
}

/**
 * BAL-411 — the expert proposed up to three alternative times for a booked consultation.
 * Published from `apps/web` after the propose api route returns 200 (mirrors
 * `BookingRescheduledPayload`'s posture).
 *
 * ⚠ NO EMAIL ADDRESS ON ANY FIELD (ADR-1044 §3) — names cross the party boundary, addresses
 * never. ⚠ NO RATE, TOTAL OR HOLD — a proposal moves no money (§D3's "nothing is held").
 */
export interface RescheduleProposalSentPayload {
  /** = proposalId (§D6) — a fresh row per propose, so re-proposing the same three slots mints
   *  a NEW id and therefore a genuinely new notification. */
  correlationId: string;
  proposalId: string;
  meetingId: string;
  engagementId: string;
  /** → recipient 'meeting_party_participants'; resolved by the PUBLISHER, never the engine. */
  recipientUserIds: string[];
  /** Prospective copy names the PARTY (CLAUDE.md). */
  expertPartyLabel: string;
  /** Retrospective — a NAME with "@ company" on first mention, never an address. */
  expertPersonLabel: string;
  clientCompanyName: string;
  caseTitle: string;
  originalScheduledStartIso: string;
  /** 1..3 ISO instants, in display order. */
  optionStartIsos: string[];
  durationMinutes: number;
  /** Drives the SMS urgency condition (`< 2` ⇒ the sms rule fires). */
  hoursToStart: number;
  expiresAtIso: string;
}

/**
 * BAL-411 — the client declined every option; the proposal is terminal. Published from
 * `apps/web` after the decline api route returns 200.
 */
export interface RescheduleProposalDeclinedPayload {
  /** = proposalId — one decline per proposal (the repository CAS is terminal). */
  correlationId: string;
  proposalId: string;
  meetingId: string;
  engagementId: string;
  /** → recipient 'expert' (resolver hydrates `data.expert`). */
  expertProfileId: string;
  clientCompanyName: string;
  caseTitle: string;
  /** A NAME with "@ company" on first mention, never an address. */
  declinedByLabel: string;
  originalScheduledStartIso: string;
  durationMinutes: number;
}
