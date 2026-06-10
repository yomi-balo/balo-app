import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

interface ProjectEoiSubmittedEmailProps extends ProjectEmailRecipientProps {
  /** Invited expert's display name — the body explains who expressed interest. */
  readonly expertName: string;
}

/**
 * Client email — an invited expert has expressed interest in the client's
 * request. CTA links to the request-detail page where the client can read the
 * pitch and message the expert. Layout lives in the shared `ProjectStatusEmail`;
 * only copy varies.
 */
export function ProjectEoiSubmittedEmail({
  firstName = 'there',
  projectTitle = 'your project',
  projectRequestId,
  expertName,
  baseUrl,
}: Readonly<ProjectEoiSubmittedEmailProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${expertName} is interested in ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="🎯 New interest"
      heroHeading="An expert is interested."
      heroSubtext="Read their pitch and start the conversation."
      bodyText={`${expertName} just expressed interest in your project. They've shared a short pitch on why they're a strong fit — open your request to read it and message them directly to scope the work.`}
      summaryLabel="Your project"
      projectTitle={projectTitle}
      calloutText="Open your request to read the expert's pitch, ask questions, and decide whether to request a full proposal."
      ctaLabel="View the request →"
      supportPrefix="Questions about your project?"
    />
  );
}
