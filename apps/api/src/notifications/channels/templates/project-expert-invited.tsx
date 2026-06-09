import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Expert email — Balo invited this expert to express interest in a project. CTA
 * links to the request-detail page where the EOI flow (A3) lives. Layout lives in
 * the shared `ProjectStatusEmail`; only copy varies.
 */
export function ProjectExpertInvitedEmail({
  firstName = 'there',
  projectTitle = 'a new project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectEmailRecipientProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, you're invited to a project: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="✨ You're invited"
      heroHeading="You're invited to a project."
      heroSubtext="Balo thinks you're a strong fit."
      bodyText="Balo invited you to express interest in a project that matches your expertise. Review the brief and, if it's a fit, send a short expression of interest to start the conversation."
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="Open the request to read the full brief, then express interest. The faster you respond, the more momentum the conversation has."
      ctaLabel="View the request →"
      supportPrefix="Questions about this invite?"
    />
  );
}
