import { passedStageClause } from './project-track-passed-stage.js';
import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Balo staff email — the delivering expert passed on a project (BAL-604). Staff are told so they
 * can invite someone else; the expert is not emailed (their own toast covers it). Names the
 * PARTIES, never a person's role: the expert by name, the client by company. REGISTER (pending-MJ):
 * factual and gender-neutral.
 */
export function ProjectTrackPassedAdminEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
  clientCompanyName = 'The client',
  expertName = 'An expert',
  fromStatus,
  onDirectLeg,
}: Readonly<
  ProjectEmailRecipientProps & {
    readonly clientCompanyName?: string;
    readonly expertName?: string;
    readonly fromStatus?: unknown;
    readonly onDirectLeg?: unknown;
  }
>) {
  const stageClause = passedStageClause(fromStatus, onDirectLeg);
  return (
    <ProjectStatusEmail
      previewText={`${expertName} passed on ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="Expert passed"
      heroHeading="An expert passed on a project."
      heroSubtext={`${expertName} passed on ${projectTitle} for ${clientCompanyName}${stageClause}.`} // pending-MJ
      bodyText="Their track has ended and any draft proposal was withdrawn. The request stays open, so Balo can invite someone else." // pending-MJ
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="Open the request to see who is still on it and invite another expert if it needs one."
      ctaLabel="Open request →"
      supportPrefix="Questions about this?"
    />
  );
}
