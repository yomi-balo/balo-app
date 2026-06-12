import React from 'react';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';
import { ProjectMatchRequestedEmail } from './project-match-requested.js';
import { ProjectExploratoryRequestedEmail } from './project-exploratory-requested.js';
import { ProjectExpertInvitedEmail } from './project-expert-invited.js';
import { ProjectEoiSubmittedEmail } from './project-eoi-submitted.js';
import { ProjectProposalRequestedEmail } from './project-proposal-requested.js';
import { ProjectProposalSubmittedEmail } from './project-proposal-submitted.js';
import { ProjectProposalAcceptedEmail } from './project-proposal-accepted.js';
import { ProjectProposalNotSelectedEmail } from './project-proposal-not-selected.js';

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
