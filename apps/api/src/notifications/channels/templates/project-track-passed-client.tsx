import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Client email — an expert who had expressed interest passed on the project (BAL-604). Sent only
 * once the client had seen the track (`eoi_submitted` / `proposal_requested`); the rule's condition
 * owns that gate. Warm and non-alarming: Balo is already looking for other experts. REGISTER
 * (pending-MJ): gender-neutral, names the expert (retrospective attribution is by person).
 */
export function ProjectTrackPassedClientEmail({
  firstName = 'there',
  projectTitle = 'your project',
  projectRequestId,
  baseUrl,
  expertName = 'An expert',
}: Readonly<ProjectEmailRecipientProps & { readonly expertName?: string }>) {
  return (
    <ProjectStatusEmail
      previewText={`${expertName} is no longer available: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="Expert update"
      heroHeading="An expert is no longer available."
      heroSubtext={`${expertName} is no longer available for this project.`} // pending-MJ
      bodyText="Balo is looking for other experts for you. There is nothing you need to do right now." // pending-MJ
      summaryLabel="Your request"
      projectTitle={projectTitle}
      calloutText="We'll let you know as soon as another expert is on board. Your request stays open in the meantime."
      ctaLabel="View request →"
      supportPrefix="Questions about this?"
    />
  );
}
