import React from 'react';
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
import { CreditDormancyReminderEmail } from './credit-dormancy-reminder.js';
import { CreditBalanceExpiredEmail } from './credit-balance-expired.js';
import { formatAudMinor, formatExpiryDateLong } from './credit-format.js';
import { PromoRedeemedEmail } from './promo-redeemed.js';
import { ProposalSharedEmail } from './proposal-shared.js';

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
        engagementUrl: `${BASE_URL}/engagements/${(data.engagementId as string) ?? ''}`,
      }),
      subject: `${sanitizeSubjectTitle(projectTitle)} is complete 🎉`,
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
