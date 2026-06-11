import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the accepting client's display name to the shared project-email props. */
export interface ProjectProposalAcceptedEmailProps extends ProjectEmailRecipientProps {
  readonly clientName: string;
}

/**
 * Winning-expert email — the client accepted this expert's proposal (BAL-289).
 * The congratulatory counterpart to `ProjectProposalNotSelectedEmail` (sent to
 * the other experts on the same request). CTA links to the request-detail page
 * where the expert kicks off the engagement. Layout lives in the shared
 * `ProjectStatusEmail`; only copy + the client name vary.
 */
export function ProjectProposalAcceptedEmail({
  firstName = 'there',
  clientName = 'The client',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectProposalAcceptedEmailProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, your proposal was accepted: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="🎉 Proposal accepted"
      heroHeading="Your proposal was accepted."
      heroSubtext="Congratulations — the client picked you for this project."
      bodyText={`${clientName} accepted your proposal. This project is officially yours: review the agreed scope and terms, then reach out to the client to plan your kickoff and get the engagement moving.`}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="We'll set up the engagement so you and the client can get started. Keep an eye out for next steps — and feel free to message the client directly to schedule your kickoff."
      ctaLabel="Open the project →"
      supportPrefix="Questions about this engagement?"
    />
  );
}
