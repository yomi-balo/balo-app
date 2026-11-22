import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the client party's name to the shared project-email props. */
export interface ProjectInvitationReminderEmailProps extends ProjectEmailRecipientProps {
  readonly companyName: string;
}

/** The client party named in the copy; a blank name falls back to "The client". */
export function invitationClientName(companyName: string | undefined): string {
  const trimmed = companyName?.trim() ?? '';
  return trimmed === '' ? 'The client' : trimmed;
}

/**
 * Expert email: a gentle follow-up while a project request still waits on the expert's answer.
 * One copy serves both invited and direct requests. Names the client party, carries no money and
 * no countdown. CTA links to the request page. Layout lives in the shared `ProjectStatusEmail`.
 */
export function ProjectInvitationReminderEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  companyName,
  baseUrl,
}: Readonly<ProjectInvitationReminderEmailProps>) {
  const client = invitationClientName(companyName);
  return (
    <ProjectStatusEmail
      // pending-MJ
      previewText={`${firstName}, ${client} is waiting on your answer about ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📬 Waiting on your answer" // pending-MJ
      heroHeading={`${client} is waiting on your answer.`} // pending-MJ
      heroSubtext="Take a look whenever suits you." // pending-MJ
      // pending-MJ
      bodyText="Open the request to read the brief and let the client know whether you'd like to take it on."
      summaryLabel="Project request" // pending-MJ
      projectTitle={projectTitle}
      // pending-MJ
      calloutText="If it isn't the right fit, you can pass from the same page. No rush."
      ctaLabel="Open the request →" // pending-MJ
      supportPrefix="Questions about this request?" // pending-MJ
    />
  );
}
