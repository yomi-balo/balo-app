import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the client party's name to the shared project-email props. */
export interface ProjectInvitationReminderEmailProps extends ProjectEmailRecipientProps {
  readonly companyName: string;
}

/** "A request from {company}", or "A request" when the company name is blank. */
export function invitationRequestFrom(companyName: string | undefined): string {
  const trimmed = companyName?.trim() ?? '';
  return trimmed === '' ? 'A request' : `A request from ${trimmed}`;
}

/**
 * Expert email: a follow-up while a project request still waits on the expert's answer. One copy
 * serves both invited and direct requests, so it says the REQUEST is waiting, never that the
 * client is: on an invitation the client can't see the expert until they express interest. It
 * gives a reason to answer either way, carries no money and no countdown, and links to the
 * request page. Layout lives in the shared `ProjectStatusEmail`.
 */
export function ProjectInvitationReminderEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  companyName,
  baseUrl,
}: Readonly<ProjectInvitationReminderEmailProps>) {
  const request = invitationRequestFrom(companyName);
  return (
    <ProjectStatusEmail
      // pending-MJ
      previewText={`${request} is waiting on your answer: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📬 Waiting on your answer" // pending-MJ
      heroHeading={`${request} is waiting on your answer.`} // pending-MJ
      heroSubtext="An answer either way keeps it moving." // pending-MJ
      // pending-MJ
      bodyText="If you'd like to take it on, saying so now gets the conversation started while the brief is fresh. If it isn't the right fit, passing lets Balo find other experts sooner."
      summaryLabel="Project request" // pending-MJ
      projectTitle={projectTitle}
      // pending-MJ
      calloutText="You can answer or pass from the request page."
      ctaLabel="Open the request →" // pending-MJ
      supportPrefix="Questions about this request?" // pending-MJ
    />
  );
}
