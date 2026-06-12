import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the requesting client's name + the change section/note to the shared props. */
export interface ProjectChangesRequestedEmailProps extends ProjectEmailRecipientProps {
  readonly clientName: string;
  /** Which part of the proposal needs work (e.g. "pricing", "milestones"). */
  readonly section: string;
  /** The client's change note — surfaced verbatim in the callout. */
  readonly note: string;
}

/**
 * Expert email — the client requested changes on the submitted proposal (A6.4 /
 * BAL-290). The mirror of `ProjectProposalSubmittedEmail` (which notifies the
 * CLIENT a proposal landed); this notifies the EXPERT that the client wants
 * revisions before accepting. CTA links to the request-detail page where the
 * expert re-opens the composer in revise mode. Layout lives in the shared
 * `ProjectStatusEmail`; only copy + the section/note vary.
 */
export function ProjectChangesRequestedEmail({
  firstName = 'there',
  clientName = 'The client',
  section = 'general',
  note = '',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectChangesRequestedEmailProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, ${clientName} requested changes: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="✏️ Changes requested"
      heroHeading={`${clientName} requested changes.`}
      heroSubtext="A few tweaks before they accept — you're close."
      bodyText={`${clientName} reviewed your proposal and asked for changes to the ${section} section before accepting. Re-open the composer to make your edits and resubmit an updated version.`}
      summaryLabel="What the client asked for"
      projectTitle={note}
      calloutText="Open your proposal to revise it — your previous version is preserved. When you resubmit, the client gets the updated proposal to review."
      ctaLabel="Revise your proposal →"
      supportPrefix="Questions about this request?"
    />
  );
}
