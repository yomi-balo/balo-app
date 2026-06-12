import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the resubmitting expert's name + the new version number to the shared props. */
export interface ProjectProposalResubmittedEmailProps extends ProjectEmailRecipientProps {
  readonly expertName: string;
  /** The new proposal version (≥2). */
  readonly version: number;
}

/**
 * Client email — the expert sent an updated proposal after the client requested
 * changes (A6.4 / BAL-290). The mirror of `ProjectProposalSubmittedEmail` (the
 * first-version submit); this notifies the CLIENT that the revised v(n) is ready
 * to review. CTA links to the request-detail page where the client reviews it.
 * Layout lives in the shared `ProjectStatusEmail`; only copy + the version vary.
 */
export function ProjectProposalResubmittedEmail({
  firstName = 'there',
  expertName = 'Your expert',
  version = 2,
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectProposalResubmittedEmailProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, ${expertName} sent an updated proposal (v${version}): ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="🔄 Updated proposal"
      heroHeading={`${expertName} sent an updated proposal (v${version}).`}
      heroSubtext="Your requested changes are in — ready for another look."
      bodyText={`${expertName} revised the proposal based on your feedback. Open the updated version (v${version}) to review the changes and decide your next step.`}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="Take your time reviewing the updated deliverables, exclusions, and payment terms. You can keep messaging the expert with any questions before you accept or request further changes."
      ctaLabel="Review the proposal →"
      supportPrefix="Questions about this proposal?"
    />
  );
}
