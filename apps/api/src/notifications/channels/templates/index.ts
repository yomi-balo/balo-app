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
import {
  PartyMemberJoinedViaDomainEmail,
  PartyJoinRequestCreatedEmail,
  PartyJoinRequestApprovedEmail,
  PartyJoinRequestDeclinedEmail,
} from './party-domain-join.js';

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

  // BAL-345 domain auto-join — requester's request approved.
  'party-join-request-approved': (data) => {
    const noun = partyNoun(data);
    return {
      component: React.createElement(PartyJoinRequestApprovedEmail, {
        firstName: (data.recipientName as string) ?? 'there',
        partyNoun: noun,
        teamUrl: `${BASE_URL}/dashboard`,
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
