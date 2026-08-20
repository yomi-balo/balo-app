import React from 'react';
import { EXPERT_CALENDAR_SETTINGS_PATH } from '@balo/shared/calendar';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ExpertReferralInvitedEmail } from './expert-referral-invited.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';
import { ProjectMatchRequestedEmail } from './project-match-requested.js';
import { ProjectExploratoryRequestedEmail } from './project-exploratory-requested.js';
import { ProjectExpertInvitedEmail } from './project-expert-invited.js';
import { ProjectEoiSubmittedEmail } from './project-eoi-submitted.js';
import { ProjectProposalRequestedEmail } from './project-proposal-requested.js';
import { ProjectProposalSubmittedEmail } from './project-proposal-submitted.js';
import { ProjectProposalAcceptedEmail } from './project-proposal-accepted.js';
import {
  ProjectKickoffApprovedExpertEmail,
  ProjectKickoffApprovedClientEmail,
} from './project-kickoff-approved.js';
import { ProjectProposalNotSelectedEmail } from './project-proposal-not-selected.js';
import { ProjectChangesRequestedEmail } from './project-changes-requested.js';
import { ProjectProposalResubmittedEmail } from './project-proposal-resubmitted.js';
import { ProjectBillingReminderOwnerEmail } from './project-billing-reminder-owner.js';
import { ProjectBillingReminderCreatorEmail } from './project-billing-reminder-creator.js';
import { EngagementMilestoneCompletedClientEmail } from './engagement-milestone-completed.js';
import { EngagementScopeChangedClientEmail } from './engagement-scope-changed.js';
import { CompletionRequestEmail } from './engagement-completion-requested.js';
import { EngagementCancelledEmail } from './engagement-cancelled.js';
import { ReviewReminderEmail } from './engagement-review-reminder.js';
import { AutoAcceptedEmail } from './engagement-auto-accepted.js';
import { AcceptedClientEmail } from './engagement-accepted-emails.js';
import { CaseClosedEmail } from './engagement-case-closed.js';
import { ReviewNudgeEmail } from './review-nudge.js';
import {
  EngagementAcceptedExpertEmail,
  EngagementAutoAcceptedExpertEmail,
  EngagementChangesRequestedExpertEmail,
  EngagementReadyToInvoiceEmail,
} from './engagement-review-decision-emails.js';
import {
  PartyMemberJoinedViaDomainEmail,
  PartyJoinRequestCreatedEmail,
  PartyJoinRequestApprovedEmail,
  PartyJoinRequestDeclinedEmail,
} from './party-domain-join.js';
import { AgencyProvisionedEmail } from './agency-provisioned.js';
import { OnboardingReminderEmail } from './onboarding-reminder.js';
import { CalendarReconnectRequiredEmail } from './calendar-reconnect-required.js';
import { CreditDormancyReminderEmail } from './credit-dormancy-reminder.js';
import { CreditBalanceExpiredEmail } from './credit-balance-expired.js';
import { CreditAutoTopupExecutedEmail } from './credit-auto-topup-executed.js';
import { CreditAutoTopupFailedEmail } from './credit-auto-topup-failed.js';
import { SessionSettledEmail } from './session-settled.js';
import { SessionSettlementFailedEmail } from './session-settlement-failed.js';
import { CreditTopupCompletedEmail } from './credit-topup-completed.js';
import { CreditTopupRequestedEmail } from './credit-topup-requested.js';
import { formatAudMinor, formatExpiryDateLong, formatPresentmentMinor } from './credit-format.js';
import { PromoRedeemedEmail } from './promo-redeemed.js';
import { ProposalSharedEmail } from './proposal-shared.js';
import {
  MeetingGuestInvitedEmail,
  MeetingGuestLinkResentEmail,
  MeetingGuestRemovedEmail,
} from './meeting-guest-emails.js';
import {
  MeetingClientAbsentEmail,
  MeetingExpertAbsentAdminEmail,
} from './meeting-absence-emails.js';
import { CaseBillingReceiptEmail } from './case-billing-emails.js';
import { ActionItemAssignedEmail } from './action-item-assigned.js';
import { RecapReadyEmail } from './recap-ready.js';
import {
  ConversationUnreadDigestEmail,
  unreadDigestSummary,
} from './conversation-unread-digest.js';
import { calendarProviderLabel } from '../../../lib/apiroc/provider-labels.js';

interface TemplateOutput {
  component: React.ReactElement;
  subject: string;
}

const BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

/** Length of an array-valued payload field; 0 when absent or not an array. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Coerce a payload field to a non-negative integer count; 0 when absent. */
function numberCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * BAL-374 — coerce a payload `cadenceStep` to a valid 1|2|3 for the reminder CTA's
 * `?step=N` param; defaults to 1 for an absent / out-of-range value.
 */
function clampCadenceStep(value: unknown): 1 | 2 | 3 {
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 1;
}

/**
 * BAL-390 — the review nudge has exactly TWO cadence steps and there cannot be a
 * third (the sweep's band math makes an anchor older than 7d+1h unmatchable), so this
 * is deliberately narrower than `clampCadenceStep` above. Anything else reads as step 1.
 */
function clampNudgeStep(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1;
}

/** BAL-390 — the engagement supertype's two children, defaulting to `project`. */
function engagementKindOf(value: unknown): 'project' | 'case' {
  return value === 'case' ? 'case' : 'project';
}

/**
 * BAL-390 — `case_engagements.close_reason`, or `undefined` when it is absent or is not
 * one of the two enum values.
 *
 * ⚠ DELIBERATELY THREE-VALUED, unlike `engagement-case-closed-client`'s inline
 * `wentQuiet ? 'auto_inactive' : 'resolved'`. That template REQUIRES a reason (its whole
 * body branches on one), so collapsing the unknown case to `resolved` is right there.
 * The nudge does not: `undefined` selects reason-blind wording that is true whichever
 * way the case closed, and silently defaulting to a reason would put a specific claim in
 * the email on no evidence.
 */
function closeReasonOf(value: unknown): 'resolved' | 'auto_inactive' | undefined {
  if (value === 'resolved' || value === 'auto_inactive') {
    return value;
  }
  return undefined;
}

/**
 * BAL-134 — a `meeting_context_type` label as a human noun for the OPS alert's triage line.
 *
 * ⚠ A LOOKUP, NOT A `replace(/_/g, ' ')`. The labels are a closed set and ops reads them at a
 * glance; a mechanical de-underscoring would render `project_discovery` as "project discovery",
 * which is not what the product calls it. An UNKNOWN label degrades to the neutral
 * "consultation" rather than leaking a raw enum string into an email.
 */
const CONTEXT_TYPE_LABELS: Readonly<Record<string, string>> = {
  case: 'Case consultation',
  project_kickoff: 'Project kickoff',
  project_discovery: 'Project discovery call',
  package_session: 'Package session',
  retainer_checkin: 'Retainer check-in',
  request_interaction: 'Request conversation',
  admin: 'Balo admin call',
};

function humaniseContextType(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Consultation';
  }
  return CONTEXT_TYPE_LABELS[value] ?? 'Consultation';
}

/**
 * BAL-345 — the joiner/requester display name from the resolver-hydrated
 * `data.user` (the SUBJECT, `payload.userId`). Degrades to "A teammate" when the
 * user has no name yet (email signups collect the name in onboarding).
 */
function partyActorName(data: Record<string, unknown>): string {
  const user = data.user as { firstName?: string | null; lastName?: string | null } | undefined;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'A teammate';
}

/** BAL-345 — human noun for the party type carried in `data.partyType`. */
function partyNoun(data: Record<string, unknown>): string {
  if (data.partyType === 'company') return 'company';
  if (data.partyType === 'agency') return 'agency';
  return 'organization';
}

const SUBJECT_TITLE_MAX_LENGTH = 160;

/**
 * Sanitise user-authored text for an email SUBJECT: strip control characters
 * (CR/LF could otherwise smuggle extra headers into the MIME envelope) and cap
 * the length so a hostile or runaway title can't bloat the subject line.
 */
export function sanitizeSubjectTitle(title: string): string {
  return (
    title
      // eslint-disable-next-line no-control-regex -- stripping control chars is the point
      .replaceAll(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, SUBJECT_TITLE_MAX_LENGTH)
  );
}

/**
 * BAL-424 — the in-app path for a conversation notice, CHOSEN BY THE ANCHOR. Mirrors
 * `conversationActionUrl` in `in-app-templates.ts`; kept a separate two-line helper rather
 * than a shared import because the email variant returns a REQUIRED path (the CTA button
 * always renders) while the in-app one returns `string | undefined`.
 *
 * ⚠ TODO(BAL-421) — `/engagements/[id]` CURRENTLY FILTERS `engagement_type = 'project'`, so
 * this path 404s for a case / package / retainer thread. UNREACHABLE TODAY: all producers
 * (`post-conversation-message.ts`, `confirm-conversation-file-upload.ts`, and the digest that
 * rides them) hard-code `contextType: 'relationship'`, so only the `/projects/{id}` branch is
 * ever taken. BAL-421 ships the case surface and owns widening that route — the link is
 * written to the shape the plan specified rather than redesigned here.
 */
function conversationPath(data: Record<string, unknown>): string {
  if (data.contextType === 'engagement') {
    const engagementId = (data.engagementId ?? data.contextId) as string | undefined;
    return engagementId ? `/engagements/${engagementId}` : '/dashboard';
  }
  const projectRequestId = data.projectRequestId as string | undefined;
  return projectRequestId ? `/projects/${projectRequestId}` : '/dashboard';
}

const templates: Record<string, (data: Record<string, unknown>) => TemplateOutput> = {
  welcome: (data) => ({
    component: React.createElement(WelcomeEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      role: (data.role as 'client' | 'expert') ?? 'client',
      baseUrl: BASE_URL,
    }),
    subject: `Welcome to Balo, ${(data.recipientName as string) ?? 'there'}!`,
  }),

  'application-submitted': (data) => ({
    component: React.createElement(ApplicationSubmittedEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      baseUrl: BASE_URL,
    }),
    subject: `Application received, ${(data.recipientName as string) ?? 'there'}.`,
  }),

  'expert-approved': (data) => ({
    component: React.createElement(ExpertApprovedEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      baseUrl: BASE_URL,
    }),
    subject: `You're approved, ${(data.recipientName as string) ?? 'there'}!`,
  }),

  // BAL-325: the resolver hydrates nothing for this event (no userId/expertProfileId/
  // companyId in the payload), so `data` carries only the payload fields. Greet
  // generically — this is an EXTERNAL non-user address, so there is no recipientName.
  'expert-referral-invited': (data) => {
    const inviterName = (data.inviterName as string) ?? 'A colleague';
    return {
      component: React.createElement(ExpertReferralInvitedEmail, {
        inviterName,
        applyUrl: `${BASE_URL}/expert/apply`,
      }),
      subject: `${sanitizeSubjectTitle(inviterName)} invited you to join Balo as an expert`,
    };
  },

  'project-request-submitted': (data) => ({
    component: React.createElement(ProjectRequestSubmittedEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      projectTitle: (data.title as string) ?? 'a new project',
      baseUrl: BASE_URL,
      tagCount: arrayLength(data.tagIds),
      productCount: arrayLength(data.productIds),
      documentCount: numberCount(data.documentCount),
    }),
    subject: `New project request: ${sanitizeSubjectTitle((data.title as string) ?? 'a new project')}`,
  }),

  'project-match-requested': (data) => {
    const company = data.company as { name?: string } | undefined;
    const companyName = company?.name ?? 'A client';
    return {
      component: React.createElement(ProjectMatchRequestedEmail, {
        projectTitle: (data.title as string) ?? 'a new project',
        companyName,
        baseUrl: BASE_URL,
        tagCount: arrayLength(data.tagIds),
        productCount: arrayLength(data.productIds),
        documentCount: numberCount(data.documentCount),
      }),
      subject: `New unrouted brief: ${sanitizeSubjectTitle((data.title as string) ?? 'a new project')}`,
    };
  },

  'project-exploratory-requested': (data) => {
    const title = (data.title as string) ?? 'your project';
    return {
      component: React.createElement(ProjectExploratoryRequestedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Let's scope your project: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-expert-invited': (data) => {
    const title = (data.title as string) ?? 'a new project';
    return {
      component: React.createElement(ProjectExpertInvitedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `You're invited: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-proposal-requested': (data) => {
    const title = (data.title as string) ?? 'a project';
    return {
      component: React.createElement(ProjectProposalRequestedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Proposal requested: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-proposal-submitted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    return {
      component: React.createElement(ProjectProposalSubmittedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        expertName,
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(expertName)} sent your proposal: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-proposal-accepted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const clientName = (data.clientName as string) ?? 'The client';
    return {
      component: React.createElement(ProjectProposalAcceptedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientName,
        clientCompany: (data.clientCompanyName as string) ?? '',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Your proposal was accepted: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-kickoff-approved-expert': (data) => {
    const title = (data.title as string) ?? 'a project';
    // Counterpart on the EXPERT email is the approving client (carries a company).
    const clientName = (data.clientName as string) ?? 'The client';
    return {
      component: React.createElement(ProjectKickoffApprovedExpertEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        counterpartName: clientName,
        counterpartCompany: (data.clientCompanyName as string) ?? '',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Kickoff approved — time to deliver: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-kickoff-approved-client': (data) => {
    const title = (data.title as string) ?? 'a project';
    // Counterpart on the CLIENT email is the delivering expert (no company).
    const expertName = (data.expertName as string) ?? 'Your expert';
    return {
      component: React.createElement(ProjectKickoffApprovedClientEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        counterpartName: expertName,
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Kickoff approved — ${sanitizeSubjectTitle(expertName)} is ready: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-changes-requested': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const clientName = (data.clientName as string) ?? 'The client';
    return {
      component: React.createElement(ProjectChangesRequestedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientName,
        section: (data.section as string) ?? 'general',
        note: (data.note as string) ?? '',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(clientName)} requested changes: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-proposal-resubmitted': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const version = numberCount(data.version) || 2;
    return {
      component: React.createElement(ProjectProposalResubmittedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        expertName,
        version,
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(expertName)} sent an updated proposal (v${version}): ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-proposal-not-selected': (data) => {
    const title = (data.title as string) ?? 'a project';
    return {
      component: React.createElement(ProjectProposalNotSelectedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `An update on your proposal: ${sanitizeSubjectTitle(title)}`,
    };
  },

  'project-eoi-submitted': (data) => {
    const title = (data.title as string) ?? 'your project';
    const expertName = (data.expertName as string) ?? 'An expert';
    return {
      component: React.createElement(ProjectEoiSubmittedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        expertName,
        baseUrl: BASE_URL,
      }),
      subject: `An expert is interested in ${sanitizeSubjectTitle(title)}`,
    };
  },

  // BAL-324 admin billing reminder — OWNER (has the CTA). `companyName` +
  // `projectTitle` carry the copy; the recipient's own name arrives as
  // `recipientName` (greeted "Hi {firstName},").
  'project-billing-reminder-owner': (data) => {
    const title = (data.title as string) ?? 'a project';
    const companyName = (data.companyName as string) ?? 'your company';
    return {
      component: React.createElement(ProjectBillingReminderOwnerEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        companyName,
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Complete your billing details to start ${sanitizeSubjectTitle(title)}`,
    };
  },

  // BAL-324 admin billing reminder — CREATOR (FYI, no CTA).
  'project-billing-reminder-creator': (data) => {
    const title = (data.title as string) ?? 'a project';
    const companyName = (data.companyName as string) ?? 'your company';
    return {
      component: React.createElement(ProjectBillingReminderCreatorEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        companyName,
        projectTitle: title,
        projectRequestId: (data.projectRequestId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `Billing details are still needed to start ${sanitizeSubjectTitle(title)}`,
    };
  },

  // BAL-332 (D2) milestone completed — CLIENT owner email. Subject names the expert
  // PARTY (prospective, BAL-329); the greeting uses the recipient's own first name.
  // The delivery note (when present) renders verbatim in the component's Callout.
  'engagement-milestone-completed-client': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(EngagementMilestoneCompletedClientEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorExpertLabel: (data.actorExpertLabel as string) ?? 'Your expert',
        milestoneTitle: (data.milestoneTitle as string) ?? 'a milestone',
        completedOn: (data.completedOn as string) ?? '',
        completionNote: data.completionNote as string | undefined,
        completedCount: numberCount(data.completedCount),
        totalCount: numberCount(data.totalCount),
        engagementId: (data.engagementId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(expertParty)} completed a milestone on ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-333 (D3) delivery-plan scope changed — CLIENT owner email. Subject names the
  // project; the body (exact ticket copy) states the price is unchanged. `projectTitle`
  // feeds both the subject and the hero project-context line in the component.
  'engagement-scope-changed-client': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(EngagementScopeChangedClientEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorExpertLabel: (data.actorExpertLabel as string) ?? 'Your expert',
        changeSummary: (data.changeSummary as string) ?? 'updated the delivery plan',
        projectTitle,
        engagementId: (data.engagementId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `The delivery plan for ${sanitizeSubjectTitle(projectTitle)} was updated`,
    };
  },

  // BAL-334 (D4) completion requested — CLIENT owner email (VARIANT 1
  // CompletionRequestEmail). Subject celebrates first (BAL-329 warm tone); the body's
  // window block keeps the auto-accept date unmissable. `recipientName` is the client
  // owner's first name (hydrated per-recipient in the delivery worker).
  'engagement-completion-requested-client': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(CompletionRequestEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        expertParty: (data.expertPartyLabel as string) ?? 'Your expert',
        actorExpert: (data.actorExpertLabel as string) ?? 'Your expert',
        projectTitle,
        milestonesTotal: numberCount(data.milestonesTotal),
        requestedDate: (data.requestedDate as string) ?? '',
        autoDate: (data.autoDate as string) ?? '',
        reviewDays: numberCount(data.reviewDays),
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
      }),
      subject: `Great news — ${sanitizeSubjectTitle(projectTitle)} is complete 🎉`,
    };
  },

  // BAL-334 (D4) engagement cancelled — one component serves BOTH the client and
  // expert rules (the greeting differs via the per-recipient `recipientName`). Subject
  // names the project; the body states the cancellation date + the recorded reason.
  'engagement-cancelled': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(EngagementCancelledEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle,
        cancelledOn: (data.cancelledOn as string) ?? '',
        reason: (data.reason as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(projectTitle)} has been cancelled`,
    };
  },

  // BAL-338 (D7) client accepted — EXPERT congrats email. Subject names the accepting
  // PERSON (retrospective) + the project; the body congratulates and states Balo owns
  // the invoice.
  'engagement-accepted-expert': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    const actorClientLabel = (data.actorClientLabel as string) ?? 'The client';
    return {
      component: React.createElement(EngagementAcceptedExpertEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorClientLabel,
        projectTitle,
        acceptedOn: (data.acceptedOn as string) ?? '',
        milestonesTotal: numberCount(data.milestonesTotal),
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(actorClientLabel)} accepted ${sanitizeSubjectTitle(projectTitle)} 🎉`,
    };
  },

  // BAL-338 (D7) client accepted — ADMIN "Ready to invoice" money email. THE SUBJECT
  // FORMAT IS STABLE across the client-accept and auto-accept paths (it is the money
  // trigger). The detail line names the accepting person (client-accept path).
  'engagement-accepted-admin': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'the project';
    const actorClientLabel = (data.actorClientLabel as string) ?? 'The client';
    return {
      component: React.createElement(EngagementReadyToInvoiceEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle,
        detailLine: `${actorClientLabel} accepted the project. Final installment is ready to invoice.`,
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `Ready to invoice: final installment — ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-338 (D7) client requested changes — EXPERT email. Subject names the person +
  // project; the body carries the client's note verbatim (Callout) + the "window
  // restarts when you re-request" line and a "view what needs to change" CTA.
  'engagement-changes-requested-expert': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    const actorClientLabel = (data.actorClientLabel as string) ?? 'The client';
    return {
      component: React.createElement(EngagementChangesRequestedExpertEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorClientLabel,
        projectTitle,
        note: (data.note as string) ?? '',
        reviewDays: numberCount(data.reviewDays) || 7,
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(actorClientLabel)} requested changes on ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-338 (D7) auto-accepted — CLIENT email (VARIANT 3 AutoAcceptedEmail, verbatim).
  // Congratulatory; the green window block confirms it closed out as delivered.
  // BAL-390 threads the RAW `reviewToken` straight through: present ⇒ the star row
  // renders inside THIS email (D7 — one email, never two); absent ⇒ the block is gone
  // and this renders exactly as it did before BAL-390.
  'engagement-auto-accepted-client': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(AutoAcceptedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        expertParty: (data.expertPartyLabel as string) ?? 'Your expert',
        projectTitle,
        milestonesTotal: numberCount(data.milestonesTotal),
        requestedDate: (data.requestedDate as string) ?? '',
        autoDate: (data.autoDate as string) ?? '',
        reviewDays: numberCount(data.reviewDays),
        reviewToken: data.reviewToken as string | undefined,
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(projectTitle)} is complete 🎉`,
    };
  },

  // BAL-390 — the client EXPLICITLY accepted: their own record of having done so, with
  // the star-rating ask fused in. Recipient 'self' via payload.userId (the
  // payment.charged actor-gets-a-receipt shape), EMAIL ONLY. Shares one body with
  // `engagement-auto-accepted-client` above (see engagement-accepted-emails.tsx) — the
  // two differ by a sentence and two templates would trip the duplication gate. Same
  // stable "is complete 🎉" subject as the auto path; only one of the two ever fires.
  'engagement-accepted-client': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(AcceptedClientEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        expertParty: (data.expertPartyLabel as string) ?? 'Your expert',
        projectTitle,
        milestonesTotal: numberCount(data.milestonesTotal),
        acceptedOn: (data.acceptedOn as string) ?? '',
        reviewToken: data.reviewToken as string | undefined,
        // STATED by the publisher, never inferred from the missing token — the token is
        // equally missing when the mint failed, and only the publisher knows which.
        alreadyRated: data.alreadyRated === true,
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(projectTitle)} is complete 🎉`,
    };
  },

  // BAL-390 (D4) case closed — CLIENT email. ONE fused email: close confirmation → the
  // green record block → the star ask when `reviewToken` is present (absent ⇒ the block
  // is gone, replaced by a short thank-you). `closeReason` switches a deliberate resolve
  // from a quiet-case close so the notice never reads as a reprimand.
  // ⚠ THE CTA IS THE RECAP, NOT THE ENGAGEMENT (BAL-388). The engagements route 404s for
  // a CASE by construction (its loader filters engagement_type = project), and BAL-388's
  // resolve action is this event's FIRST and only publisher — so the one navigation this
  // email carries has to be live. `?from=notification` is what makes `recap_viewed.source`
  // readable for the recap's primary entry point. No `meetingId` ⇒ NO button, never a dead one.
  'engagement-case-closed-client': (data) => {
    const caseTitle = (data.caseTitle as string) ?? 'your case';
    const wentQuiet = data.closeReason === 'auto_inactive';
    const meetingId = data.meetingId as string | undefined;
    return {
      component: React.createElement(CaseClosedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        expertParty: (data.expertPartyLabel as string) ?? 'your expert',
        caseTitle,
        closedDate: (data.closedDate as string) ?? '',
        closeReason: wentQuiet ? 'auto_inactive' : 'resolved',
        consultationCount: data.consultationCount as number | undefined,
        reviewToken: data.reviewToken as string | undefined,
        recapUrl: meetingId ? `${BASE_URL}/meetings/${meetingId}?from=notification` : undefined,
        baseUrl: BASE_URL,
      }),
      subject: wentQuiet
        ? `We've closed ${sanitizeSubjectTitle(caseTitle)}`
        : `${sanitizeSubjectTitle(caseTitle)} is wrapped up`,
    };
  },

  // BAL-390 — the star-rating nudge (+24h / +7d), server-published by the hourly
  // review-nudge sweep, EMAIL ONLY to the reviewer. `cadenceStep` drives the copy: step
  // 1 is a light touch, step 2 LEADS with the regrounding and is the last ask (the band
  // math forbids a third). ⚠ NOT `engagement-review-reminder-client`, which is BAL-338's
  // pre-auto-accept "review the delivered work" nudge — different event and meaning.
  'review-nudge': (data) => {
    const engagementTitle = (data.engagementTitle as string) ?? 'your engagement';
    const step = clampNudgeStep(data.cadenceStep);
    const expertParty = (data.expertPartyLabel as string) ?? 'your expert';
    return {
      component: React.createElement(ReviewNudgeEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        cadenceStep: step,
        engagementKind: engagementKindOf(data.engagementKind),
        engagementTitle,
        expertParty,
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        anchorDate: (data.anchorDate as string) ?? '',
        consultationCount: data.consultationCount as number | undefined,
        // CASE ONLY — step 2 states WHY the case closed, so a deliberate `resolved`
        // close must never be described as having gone quiet. Absent ⇒ neutral wording.
        closeReason: closeReasonOf(data.closeReason),
        reviewToken: (data.reviewToken as string) ?? '',
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject:
        step === 2
          ? `One last look back at ${sanitizeSubjectTitle(engagementTitle)}`
          : `How did it go with ${sanitizeSubjectTitle(expertParty)}?`,
    };
  },

  // BAL-338 (D7) auto-accepted — EXPERT congrats email.
  'engagement-auto-accepted-expert': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(EngagementAutoAcceptedExpertEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'The client',
        projectTitle,
        autoDate: (data.autoDate as string) ?? '',
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(projectTitle)} is complete 🎉`,
    };
  },

  // BAL-338 (D7) auto-accepted — ADMIN "Ready to invoice" money email (SAME stable
  // subject as the client-accept path). The detail line notes the auto path + window.
  'engagement-auto-accepted-admin': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'the project';
    const reviewDays = numberCount(data.reviewDays) || 7;
    return {
      component: React.createElement(EngagementReadyToInvoiceEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle,
        detailLine: `The project was accepted automatically (${reviewDays}-day review window). Final installment is ready to invoice.`,
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
        baseUrl: BASE_URL,
      }),
      subject: `Ready to invoice: final installment — ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-338 (D7) T-2 review reminder — CLIENT email (VARIANT 2 ReviewReminderEmail,
  // verbatim). One friendly nudge; the amber window block keeps the auto-accept date
  // unmissable. `daysLeft` is computed at send time by the reminder sweep.
  'engagement-review-reminder-client': (data) => {
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(ReviewReminderEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        clientCompany: (data.clientCompanyName as string) ?? 'your team',
        expertParty: (data.expertPartyLabel as string) ?? 'Your expert',
        projectTitle,
        milestonesTotal: numberCount(data.milestonesTotal),
        requestedDate: (data.requestedDate as string) ?? '',
        autoDate: (data.autoDate as string) ?? '',
        daysLeft: numberCount(data.daysLeft),
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
      }),
      subject: `Your completed project is waiting — ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-345 domain auto-join — admin FYI (in-app is the live channel; the email
  // template is registered for completeness/coverage).
  'party-member-joined-via-domain': (data) => {
    const actorName = partyActorName(data);
    const noun = partyNoun(data);
    return {
      component: React.createElement(PartyMemberJoinedViaDomainEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorName,
        partyNoun: noun,
        teamUrl: `${BASE_URL}/settings/team`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(actorName)} joined your ${noun}`,
    };
  },

  // BAL-345 domain auto-join — admins must approve/decline.
  'party-join-request-created': (data) => {
    const actorName = partyActorName(data);
    const noun = partyNoun(data);
    return {
      component: React.createElement(PartyJoinRequestCreatedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        actorName,
        partyNoun: noun,
        teamUrl: `${BASE_URL}/settings/team`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(actorName)} requested to join your ${noun}`,
    };
  },

  // BAL-345 domain auto-join — requester's request approved. BAL-348: the CTA
  // converges with the in-app deep-link — it lands the requester on the approved
  // terminal screen (`/onboarding/join-result`), which re-validates membership
  // server-side, rather than straight to /dashboard. The landing surface is
  // COMPANY-ONLY, so an agency party (or a payload with no partyId) falls back to
  // /dashboard — the company-only landing link is never emitted for an agency.
  'party-join-request-approved': (data) => {
    const noun = partyNoun(data);
    const partyId = typeof data.partyId === 'string' ? data.partyId : undefined;
    const teamUrl =
      data.partyType === 'company' && partyId
        ? `${BASE_URL}/onboarding/join-result?status=approved&party=${partyId}`
        : `${BASE_URL}/dashboard`;
    return {
      component: React.createElement(PartyJoinRequestApprovedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        partyNoun: noun,
        teamUrl,
        baseUrl: BASE_URL,
      }),
      subject: `You're in — your request to join the ${noun} was approved`,
    };
  },

  // BAL-345 domain auto-join — requester's request declined.
  'party-join-request-declined': (data) => {
    const noun = partyNoun(data);
    return {
      component: React.createElement(PartyJoinRequestDeclinedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        partyNoun: noun,
        baseUrl: BASE_URL,
      }),
      subject: `An update on your request to join the ${noun}`,
    };
  },

  // BAL-348 agency provisioned — owner milestone email. `data.agency` is the
  // resolver-hydrated agency summary (name only used); the greeting comes from
  // `recipientName` (= the owner). CTA points at the team/members settings surface.
  'agency-provisioned': (data) => {
    const agency = data.agency as { name?: string } | undefined;
    // Capitalized to match the in-app title fallback ('Your team is set up') and to
    // read correctly at the start of the subject line. Defensive only — agency.provisioned
    // always hydrates data.agency.name, so this fallback is effectively unreachable.
    const teamName = agency?.name ?? 'Your team';
    return {
      component: React.createElement(AgencyProvisionedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        teamName,
        teamUrl: `${BASE_URL}/settings/team`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(teamName)} is set up on Balo`,
    };
  },

  // BAL-374 onboarding-completion reminder — server-only, EMAIL ONLY to the
  // un-onboarded user. The greeting uses `recipientName` (adapter = user.firstName,
  // 'there' fallback for a name-less bouncer); `cadenceStep` only parameterises the
  // CTA's `?step=N` (clamped to 1..3) + analytics — the copy never varies by step.
  // Names nothing else (the user may have no org). Stable subject across steps.
  'onboarding-reminder': (data) => {
    const step = clampCadenceStep(data.cadenceStep);
    return {
      component: React.createElement(OnboardingReminderEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        ctaUrl: `${BASE_URL}/onboarding?src=onboarding_reminder&step=${step}`,
        baseUrl: BASE_URL,
      }),
      subject: 'Finish setting up your Balo account',
    };
  },

  // BAL-396 §7 (Objection 5) — `calendar.auth_error` already existed and already published;
  // this is its first template (no rule existed either — see `engine/rules.ts`). Recipient is
  // the DELIVERING EXPERT (`recipient: 'expert'` via `payload.expertProfileId`). `providerLabel`
  // derives from the payload's `provider` field — never branch on it beyond this label lookup.
  'calendar-reconnect-required': (data) => ({
    component: React.createElement(CalendarReconnectRequiredEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      providerLabel: calendarProviderLabel(data.provider),
      ctaUrl: `${BASE_URL}${EXPERT_CALENDAR_SETTINGS_PATH}`,
      baseUrl: BASE_URL,
    }),
    subject: 'Reconnect your calendar to keep taking bookings',
  }),

  // BAL-380 (ADR-1040 Lane 3) dormancy reminder — server-only, EMAIL to the company's
  // billing admins. `window` (60|30 in the merged payload) selects the copy + subject;
  // `balanceMinor`/`expiresAt` are formatted here for display. Warm, non-countdown. CTA
  // points at expert search (find-an-expert / start-a-consultation both land on /experts).
  'credit-dormancy-reminder': (data) => {
    const window = data.window === 30 ? 30 : 60;
    const balance = formatAudMinor(numberCount(data.balanceMinor));
    const expiryDate = formatExpiryDateLong((data.expiresAt as string) ?? '');
    const subject =
      window === 30
        ? 'A good time to put your Balo balance to use'
        : 'Your Balo balance is here whenever you need it';
    return {
      component: React.createElement(CreditDormancyReminderEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        window,
        balance,
        expiryDate,
        ctaUrl: `${BASE_URL}/experts`,
        baseUrl: BASE_URL,
      }),
      subject,
    };
  },

  // BAL-380 (ADR-1040 Lane 3) balance expired — server-only, EMAIL to the billing
  // admins. Soft-toned, provisional (no balance figure — 0 post-expiry). Stable subject.
  // "Add credit" points at the wallet/billing panel (delivered by a later credit-system
  // lane; the canonical /settings/billing route per the billing-settings design ref).
  'credit-balance-expired': (data) => {
    const expiryDate = formatExpiryDateLong((data.expiresAt as string) ?? '');
    return {
      component: React.createElement(CreditBalanceExpiredEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        expiryDate,
        ctaUrl: `${BASE_URL}/settings/billing`,
        baseUrl: BASE_URL,
      }),
      subject: 'About your Balo balance',
    };
  },

  // BAL-379 (ADR-1040) auto-top-up executed — server-only, EMAIL to the billing admins. Warm
  // confirmation; `reloadedMinor` / `balanceAfterMinor` / `expiresAt` are AUD face-value display
  // facts formatted here (NO fee/margin/overdraft figure). CTA lands on the billing panel.
  'credit-auto-topup-executed': (data) => {
    const expiresAtIso = (data.expiresAt as string) ?? '';
    return {
      component: React.createElement(CreditAutoTopupExecutedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        reloaded: formatAudMinor(numberCount(data.reloadedMinor)),
        balanceAfter: formatAudMinor(numberCount(data.balanceAfterMinor)),
        expiryDate: expiresAtIso ? formatExpiryDateLong(expiresAtIso) : '',
        ctaUrl: `${BASE_URL}/settings/billing`,
        baseUrl: BASE_URL,
      }),
      subject: "Auto-top-up complete — your team's balance is topped up",
    };
  },

  // BAL-379 (ADR-1040) auto-top-up failed — server-only, EMAIL to the billing admins. Calm,
  // non-dunning (NO receivable, nothing owed). `reason` switches SCA vs hard-decline copy;
  // `attemptedMinor` is the AUD reload face value. CTA lands on the billing panel.
  'credit-auto-topup-failed': (data) => {
    const reason = data.reason === 'requires_action' ? 'requires_action' : 'declined';
    return {
      component: React.createElement(CreditAutoTopupFailedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        attempted: formatAudMinor(numberCount(data.attemptedMinor)),
        reason,
        ctaUrl: `${BASE_URL}/settings/billing`,
        baseUrl: BASE_URL,
      }),
      subject:
        reason === 'requires_action'
          ? 'Confirm your card to keep auto-top-up on'
          : 'A quick card update keeps auto-top-up on',
    };
  },

  // BAL-378 (ADR-1040 Lane 2) session settled — billing-admin receipt. `overdraftSettledMinor`
  // switches the "extra time settled" receipt vs the "wrapped up within your balance" note;
  // `expertName` + `settledOn` come from the payload. No "overdraft" anywhere.
  'session-settled': (data) => {
    const overdraft = numberCount(data.overdraftSettledMinor);
    const expertName = (data.expertName as string) ?? 'your expert';
    const hadOverdraft = overdraft > 0;
    return {
      component: React.createElement(SessionSettledEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        expertName,
        amount: formatAudMinor(overdraft),
        settledOn: (data.settledOn as string) ?? '',
        hadOverdraft,
        ctaUrl: `${BASE_URL}/settings/billing`,
        baseUrl: BASE_URL,
      }),
      subject: hadOverdraft
        ? `Settled: your session with ${sanitizeSubjectTitle(expertName)}`
        : `Your session with ${sanitizeSubjectTitle(expertName)} wrapped up`,
    };
  },

  // BAL-378 (ADR-1040 Lane 2) settlement failed — billing-admin dunning. `reason` switches the
  // SCA "confirm your card" recovery vs the hard-decline "update your card" copy. Warm, no
  // "overdraft". The expert has already been paid — this is only about clearing the card.
  'session-settlement-failed': (data) => {
    const reason = data.reason === 'requires_action' ? 'requires_action' : 'declined';
    return {
      component: React.createElement(SessionSettlementFailedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        amount: formatAudMinor(numberCount(data.amountMinor)),
        reason,
        ctaUrl: `${BASE_URL}/settings/billing`,
        baseUrl: BASE_URL,
      }),
      subject:
        reason === 'requires_action'
          ? 'Confirm your card to settle your recent session'
          : 'A payment on your recent session needs attention',
    };
  },

  // BAL-377 (ADR-1040 Lane 1) top-up receipt — server-only, EMAIL to the PURCHASER
  // (recipient 'self'). All figures are display facts captured at webhook time
  // (creditedMinor / chargedCurrency / chargedAmountMinor / promoGrantedMinor /
  // balanceAfterMinor / expiresAt in the merged payload), formatted here. The presentment
  // "charged as" line shows ONLY on a non-AUD card (chargedCurrency !== 'aud'); an AUD buyer
  // isn't shown "A$X → A$X". NO fee figure (BAL-357). Warm, congratulatory; rolling expiry
  // framed as reassurance.
  'credit-topup-completed': (data) => {
    const chargedCurrency = ((data.chargedCurrency as string) ?? 'aud').toLowerCase();
    const promoGrantedMinor = numberCount(data.promoGrantedMinor);
    return {
      component: React.createElement(CreditTopupCompletedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        credited: formatAudMinor(numberCount(data.creditedMinor)),
        charged: formatPresentmentMinor(numberCount(data.chargedAmountMinor), chargedCurrency),
        showCharged: chargedCurrency !== 'aud',
        promoBonus: promoGrantedMinor > 0 ? formatAudMinor(promoGrantedMinor) : null,
        balanceAfter: formatAudMinor(numberCount(data.balanceAfterMinor)),
        expiryDate: formatExpiryDateLong((data.expiresAt as string) ?? ''),
        ctaUrl: `${BASE_URL}/experts`,
        baseUrl: BASE_URL,
      }),
      subject: "You're topped up — your balance is ready",
    };
  },

  // BAL-377 / BAL-381 top-up nudge — EMAIL to each fanned-out MANAGE_BILLING holder. The
  // nudging member's name arrives as `data.requesterName` (resolver hydrates it from
  // payload.requestedByUserId); the recipient's own first name is `recipientName`. CTA lands
  // on the top-up composer.
  'credit-topup-requested': (data) => {
    const memberName = (data.requesterName as string) ?? 'A teammate';
    return {
      component: React.createElement(CreditTopupRequestedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        memberName,
        ctaUrl: `${BASE_URL}/billing/top-up`,
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(memberName)} asked you to top up your team's balance`,
    };
  },

  // BAL-383 (ADR-1040) promo redeemed — warm milestone confirmation to the ACTOR who
  // redeemed (recipient 'self'). `recipientName` greets the actor; `code` / `grantedLabel`
  // / `companyName` come straight from the payload (spread into `data`). The CTA points at
  // expert search — the natural next step once credit lands.
  'promo-redeemed': (data) => {
    const grantedLabel = (data.grantedLabel as string) ?? 'your credit';
    const companyName = (data.companyName as string) ?? 'your team';
    return {
      component: React.createElement(PromoRedeemedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        code: (data.code as string) ?? 'your code',
        grantedLabel,
        companyName,
        ctaUrl: `${BASE_URL}/experts`,
        baseUrl: BASE_URL,
      }),
      subject: `${grantedLabel} in Balo credit is ready`,
    };
  },

  // BAL-399 (ADR-1040 / ADR-1043) payment charged — the acting MEMBER's consultation receipt
  // (recipient 'self'). The all-in charge ONLY (`amountAudMinor` = connectedMinutes × client
  // rate); NO expert figure / margin (fee concealment). `recipientName` greets the member.
  'payment-charged': (data) => {
    const expertName = (data.expertName as string) ?? 'your expert';
    const amount = formatAudMinor(numberCount(data.amountAudMinor));
    const durationMinutes = numberCount(data.durationMinutes);
    const chargedOn = (data.chargedOn as string) ?? '';
    return {
      component: React.createElement(CaseBillingReceiptEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        previewText: `Your ${durationMinutes}-minute session with ${expertName} came to ${amount}.`,
        pillLabel: '💳 Session receipt',
        pillTone: 'primary',
        heading: 'Your session wrapped up',
        subtext: 'A quick receipt for your records.',
        bodyLines: [
          `Your ${durationMinutes}-minute session with ${expertName} on ${chargedOn} wrapped up.`,
          `The total came to ${amount} — nothing further to do.`,
        ],
        ctaLabel: 'View billing →',
        ctaUrl: `${BASE_URL}/settings/billing`,
        footerPrefix: 'Questions about this charge?',
        baseUrl: BASE_URL,
      }),
      subject: `Your session with ${sanitizeSubjectTitle(expertName)} — receipt`,
    };
  },

  // BAL-399 (ADR-1040 / ADR-1043) payout recorded — the delivering EXPERT's own-earnings notice
  // (recipient 'expert'). Own earnings ONLY (`amountAudMinor` = expertAccruedMinor); NO client
  // charge / markup / margin (fee concealment). `recipientName` greets the expert.
  'payout-recorded': (data) => {
    const amount = formatAudMinor(numberCount(data.amountAudMinor));
    const durationMinutes = numberCount(data.durationMinutes);
    const recordedOn = (data.recordedOn as string) ?? '';
    return {
      component: React.createElement(CaseBillingReceiptEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        previewText: `${amount} from your ${durationMinutes}-minute session is recorded.`,
        pillLabel: '✅ Earnings recorded',
        pillTone: 'success',
        heading: 'Your earnings are recorded',
        subtext: "Nice work — this one's in the books.",
        bodyLines: [
          `Your ${durationMinutes}-minute session on ${recordedOn} wrapped up, and ${amount} in earnings is recorded.`,
          'It will be included in your next payout — nothing you need to do.',
        ],
        ctaLabel: 'View earnings →',
        ctaUrl: `${BASE_URL}/settings/earnings`,
        footerPrefix: 'Questions about your earnings?',
        baseUrl: BASE_URL,
      }),
      subject: 'Your session earnings are recorded',
    };
  },

  // BAL-391 (ADR-1043) action item assigned — ONE component serves BOTH the client and
  // expert rules (the greeting differs via the per-recipient `recipientName`). Subject
  // names the retrospective actor + the project; the body carries the item text and the
  // optional due date as a helpful fact. CTA deep-links to the delivery workspace.
  'action-item-assigned': (data) => {
    const actorLabel = (data.actorLabel as string) ?? 'A teammate';
    const projectTitle = (data.projectTitle as string) ?? 'your project';
    return {
      component: React.createElement(ActionItemAssignedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        projectTitle,
        actorLabel,
        actionItemBody: (data.actionItemBody as string) ?? 'an action item',
        dueOn: data.dueOn as string | undefined,
        engagementId: (data.engagementId as string) ?? '',
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(actorLabel)} assigned you an action item on ${sanitizeSubjectTitle(projectTitle)}`,
    };
  },

  // BAL-387 (ADR-1013 + ADR-1043) transcript recap ready — ONE component serves BOTH the client
  // owner and the delivering expert (the greeting differs via the per-recipient `recipientName`).
  // Carries no money (fee-safe); `summaryHeadline` / `actionItemCount` come straight from the
  // payload. CTA deep-links to the MEETING RECAP `/meetings/{meetingId}` (BAL-388).
  'recap-ready': (data) => ({
    component: React.createElement(RecapReadyEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      summaryHeadline: data.summaryHeadline as string | undefined,
      actionItemCount: numberCount(data.actionItemCount),
      meetingId: (data.meetingId as string) ?? '',
      baseUrl: BASE_URL,
    }),
    subject: 'Your session recap is ready',
  }),

  /**
   * BAL-424 — the debounced unread digest. The CTA is ANCHOR-AWARE (`/engagements/{id}` for
   * an engagement thread, `/projects/{id}` for a relationship thread); the subject names the
   * counterparty, which ADR-1044 permits for a NAME and never for an address.
   */
  'conversation-unread-digest': (data) => {
    // ⚠ `senderName` IS NULLABLE BY CONTRACT: the fire-time guard sets it to `null` when the
    // coalesced window spans MORE THAN ONE sender, and the copy then names the THREAD rather
    // than misattributing everything to whoever happened to write last. A `?? 'Someone'`
    // would paper over that deliberate null with a fake attribution.
    const rawSender = data.senderName;
    const senderName = typeof rawSender === 'string' && rawSender.length > 0 ? rawSender : null;
    const title = (data.title as string) ?? 'your conversation';
    const unreadMessageCount = numberCount(data.unreadMessageCount);
    const unreadFileCount = numberCount(data.unreadFileCount);
    const summary = unreadDigestSummary(unreadMessageCount, unreadFileCount);
    return {
      component: React.createElement(ConversationUnreadDigestEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        senderName,
        title,
        unreadMessageCount,
        unreadFileCount,
        preview: data.preview as string | undefined,
        fileName: data.fileName as string | undefined,
        conversationUrl: `${BASE_URL}${conversationPath(data)}`,
        baseUrl: BASE_URL,
      }),
      subject:
        senderName === null
          ? `${summary} on ${sanitizeSubjectTitle(title)}`
          : `${summary} from ${sanitizeSubjectTitle(senderName)}`,
    };
  },

  // BAL-386 — a client member shared a submitted proposal with an EXTERNAL colleague
  // (external `email_address` path — no user row to hydrate). The magic-link CTA is
  // the ONLY link; the raw token is never rendered as copyable text. The subject
  // names the sharer (retrospective), sanitized against header injection.
  'proposal-shared': (data) => {
    const sharerName = (data.sharerName as string) ?? 'A colleague';
    const shareToken = (data.shareToken as string) ?? '';
    return {
      component: React.createElement(ProposalSharedEmail, {
        sharerName,
        sharerOrgLabel: (data.sharerOrgLabel as string) ?? 'their team',
        proposalTitle: (data.proposalTitle as string) ?? 'a proposal',
        note: data.note as string | undefined,
        expiresOn: (data.expiresOn as string) ?? '',
        viewUrl: `${BASE_URL}/shared/proposals/${shareToken}`,
      }),
      subject: `${sanitizeSubjectTitle(sharerName)} shared a proposal with you`,
    };
  },

  // BAL-408 — an EXTERNAL person was invited to a consultation (external `email_address`
  // path — no user row to hydrate). The magic-link CTA is the ONLY link and the raw token
  // is never rendered as copyable text (the `proposal-shared` rule). The subject names the
  // inviter retrospectively, sanitized against header injection.
  // ⚠ NO BILLING LINE — see the file docblock on `meeting-guest-emails.tsx`.
  'meeting-guest-invited': (data) => {
    const inviterName = (data.inviterName as string) ?? 'A colleague';
    const joinToken = (data.joinToken as string) ?? '';
    /**
     * ⚠⚠ A MALFORMED `accessScope` DEGRADES TO THE **WIDER** DISCLOSURE, `engagement`.
     * This block previously degraded to `meeting` while its own comment said the opposite;
     * the comment was right and the code was wrong, and the direction matters:
     *
     *   · This is a CONSENT DISCLOSURE, not a permission. It grants nothing — the grant is
     *     already stored on `meeting_guests.access_scope` and is enforced (by BAL-388)
     *     from the row, never from this string. So the only thing at stake here is what
     *     the person is TOLD.
     *   · Rendering the narrow copy for a row that actually holds `engagement` hides a
     *     RETROSPECTIVE grant from the very person it is about — the exact failure the
     *     whole disclosure exists to prevent, and unrecoverable (they have no account in
     *     which to discover it later).
     *   · Rendering the wide copy for a `meeting`-scoped row over-states what they can
     *     read. Nothing is exposed; the worst case is a guest who expects more history
     *     than they get.
     *
     * Over-disclose, never under-disclose. `meeting-guest-emails.test.ts` states the same
     * rule, and the landing's `AccessScopeDisclosure` takes the enum directly from the row
     * so it has no equivalent fallback to keep in step.
     */
    const accessScope = data.accessScope === 'meeting' ? 'meeting' : 'engagement';
    // ⚠ NO `'their team'` PLACEHOLDER. `personWithOrgLabel` drops the "@ org" clause when
    // the label is absent or IS the person (an independent expert), so the honest fallback
    // is the inviter's own name, not a stand-in that reads like an unsubstituted variable.
    const inviterOrgLabel = (data.inviterOrgLabel as string) ?? inviterName;
    return {
      component: React.createElement(MeetingGuestInvitedEmail, {
        guestName: data.guestName as string | undefined,
        inviterName,
        inviterOrgLabel,
        // Engagement-type-agnostic: the service already resolves a real title or a
        // context-specific label ('a discovery call', 'a project kickoff'), so this
        // fallback fires only on a malformed payload and must not name a case.
        meetingTitle: (data.meetingTitle as string) ?? 'a call',
        scheduledStartIso: (data.scheduledStartIso as string) ?? '',
        scheduledEndIso: (data.scheduledEndIso as string) ?? '',
        accessScope,
        expiresOn: (data.expiresOn as string) ?? '',
        joinUrl: `${BASE_URL}/join/${joinToken}`,
        // ⚠ THE SHELL'S FOOTER BASE, DELIBERATELY SEPARATE FROM `joinUrl`. `EmailShell`
        // concatenates `/legal/privacy` onto whatever it is given, so passing the join URL
        // here minted `…/join/{RAW_TOKEN}/legal/privacy` — a dead link AND a second copy of
        // the credential in the most-forwarded message on the platform.
        baseUrl: BASE_URL,
      }),
      subject: `${sanitizeSubjectTitle(inviterName)} invited you to a video call`,
    };
  },

  // BAL-436 — a host re-sent an admitted guest's join link, rotating the credential. To that
  // person ONLY, external `email_address` path. The CTA is the ONLY link and the raw token is
  // never rendered as copyable text (the `proposal-shared` rule).
  // ⚠ THE SUBJECT NAMES NOBODY. This row was self-claimed, so there is no inviter to name —
  // and no `sanitizeSubjectTitle` call is needed because nothing caller-supplied reaches it.
  // ⚠ NO BILLING LINE — see the file docblock on `meeting-guest-emails.tsx`.
  'meeting-guest-link-resent': (data) => {
    const joinToken = (data.joinToken as string) ?? '';
    return {
      component: React.createElement(MeetingGuestLinkResentEmail, {
        guestName: data.guestName as string | undefined,
        // Engagement-type-agnostic, exactly as the invite's is: the service resolves a real
        // title or a context-specific label, so this fallback fires only on a malformed
        // payload and must not name a case.
        meetingTitle: (data.meetingTitle as string) ?? 'a call',
        scheduledStartIso: (data.scheduledStartIso as string) ?? '',
        scheduledEndIso: (data.scheduledEndIso as string) ?? '',
        expiresOn: (data.expiresOn as string) ?? '',
        joinUrl: `${BASE_URL}/join/${joinToken}`,
        // ⚠ THE SHELL'S FOOTER BASE, DELIBERATELY SEPARATE FROM `joinUrl` — passing the join
        // URL here would mint `…/join/{RAW_TOKEN}/legal/privacy`: a dead link AND a second
        // copy of the credential.
        baseUrl: BASE_URL,
      }),
      subject: 'Your new link for the video call',
    };
  },

  // BAL-408 — a guest's access was revoked. To that person ONLY, no CTA (their link is
  // dead and there is nothing else an external non-user may open).
  'meeting-guest-removed': (data) => ({
    component: React.createElement(MeetingGuestRemovedEmail, {
      guestName: data.guestName as string | undefined,
      meetingTitle: (data.meetingTitle as string) ?? 'a call',
      scheduledStartIso: (data.scheduledStartIso as string) ?? '',
      baseUrl: BASE_URL,
    }),
    subject: 'Your call invitation has been withdrawn',
  }),

  // BAL-134 — the Balo-ops salvage alert. `recipient: 'admin'` resolves to the literal
  // `OPS_NOTIFICATION_EMAIL` in the dispatcher (the `project-match-requested` precedent).
  // ⚠ THE SUBJECT NAMES NO PERSON — ops triages by meeting, and a name frozen at schedule time
  // would be stale by fire time and is PII parked in a table for nothing.
  'meeting-expert-absent-admin': (data) => ({
    component: React.createElement(MeetingExpertAbsentAdminEmail, {
      meetingId: (data.meetingId as string) ?? '',
      minutesPastStart: numberCount(data.minutesPastStart),
      contextLabel: humaniseContextType(data.contextType),
      scheduledStartIso: (data.scheduledStartIso as string) ?? '',
      baseUrl: BASE_URL,
    }),
    subject: 'Expert has not joined a consultation',
  }),

  // BAL-134 — the client nudge. ⚠ NO BILLING LINE ANYWHERE: nothing is charged until both
  // sides are present, so a charge claim would be false, and a "you will be charged" line would
  // be a threat aimed at somebody a few minutes late.
  'meeting-client-absent': (data) => ({
    component: React.createElement(MeetingClientAbsentEmail, {
      firstName: (data.recipientName as string) ?? 'there',
      // ⚠ EXPLICITLY `undefined` RATHER THAN A PLACEHOLDER — the component renders
      // party-neutral copy for it, and inventing a name on a live delivery surface is worse
      // than saying "your expert".
      waitingPartyName:
        typeof data.waitingPartyName === 'string' && data.waitingPartyName.length > 0
          ? data.waitingPartyName
          : undefined,
      meetingId: (data.meetingId as string) ?? '',
      baseUrl: BASE_URL,
    }),
    subject: 'Your consultation has started',
  }),
};

export function getEmailTemplate(
  templateName: string,
  data: Record<string, unknown>
): TemplateOutput {
  const factory = templates[templateName];
  if (!factory) {
    throw new Error(`Unknown email template: ${templateName}`);
  }
  return factory(data);
}
