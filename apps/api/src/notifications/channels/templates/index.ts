import React from 'react';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';

interface TemplateOutput {
  component: React.ReactElement;
  subject: string;
}

const BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

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
    }),
    subject: `New project request: ${(data.title as string) ?? 'a new project'}`,
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
