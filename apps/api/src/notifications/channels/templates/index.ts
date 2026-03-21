import React from 'react';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';

interface TemplateOutput {
  component: React.ReactElement;
  subject: string;
}

const BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

const templates: Record<string, (data: Record<string, unknown>) => TemplateOutput> = {
  welcome: (data) => ({
    component: React.createElement(WelcomeEmail, {
      recipientName: (data.recipientName as string) ?? 'there',
      baseUrl: BASE_URL,
    }),
    subject: 'Welcome to Balo',
  }),

  'application-submitted': (data) => ({
    component: React.createElement(ApplicationSubmittedEmail, {
      recipientName: (data.recipientName as string) ?? 'there',
    }),
    subject: 'We received your application',
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
