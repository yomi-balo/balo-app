import React from 'react';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';
import { ProjectMatchRequestedEmail } from './project-match-requested.js';
import { ProjectExploratoryRequestedEmail } from './project-exploratory-requested.js';
import { ProjectExpertInvitedEmail } from './project-expert-invited.js';
import { ProjectEoiSubmittedEmail } from './project-eoi-submitted.js';

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
    subject: `New project request: ${(data.title as string) ?? 'a new project'}`,
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
      subject: `New unrouted brief: ${(data.title as string) ?? 'a new project'}`,
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
      subject: `Let's scope your project: ${title}`,
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
      subject: `You're invited: ${title}`,
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
      subject: `An expert is interested in ${title}`,
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
