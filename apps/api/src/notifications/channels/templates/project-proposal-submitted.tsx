import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the submitting expert's display name to the shared project-email props. */
export interface ProjectProposalSubmittedEmailProps extends ProjectEmailRecipientProps {
  readonly expertName: string;
}

/**
 * Client email — the expert submitted their formal proposal (A6.2 / BAL-288).
 * The mirror of `ProjectProposalRequestedEmail` (which notifies the EXPERT that a
 * proposal was requested); this notifies the CLIENT that the proposal has landed.
 * CTA links to the request-detail page where the client reviews it (A6.3). Layout
 * lives in the shared `ProjectStatusEmail`; only copy + the expert name vary.
 */
export function ProjectProposalSubmittedEmail({
  firstName = 'there',
  expertName = 'Your expert',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectProposalSubmittedEmailProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, ${expertName} sent your proposal: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📋 Proposal received"
      heroHeading={`${expertName} sent your proposal.`}
      heroSubtext="Scope, deliverables, and price — ready for your review."
      bodyText={`${expertName} has put together a formal proposal for your project: scope, deliverables, payment schedule, and terms. Open it to review the details and decide your next step.`}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="Take your time reviewing the deliverables, exclusions, and payment terms. You can keep messaging the expert with any questions before you accept or request changes."
      ctaLabel="Review the proposal →"
      supportPrefix="Questions about this proposal?"
    />
  );
}
