import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Expert email — one track declined (client, or Balo on the client's behalf) (BAL-540). Two
 * bodies keyed on `stage`: an `invited` decline is a plain invitation withdrawal (nothing beyond
 * the brief was ever shared); anything later reads as "not proceeding". REGISTER (pending-MJ):
 * factual, non-adversarial, gender-neutral. Prospective copy names the PARTY (CLAUDE.md).
 */
export function ProjectTrackDeclinedEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
  clientCompanyName = 'The client',
  stage,
}: Readonly<
  ProjectEmailRecipientProps & { readonly clientCompanyName?: string; readonly stage?: unknown }
>) {
  const isInvitedDecline = stage === 'invited';
  // ⚠ THE HERO AND THE BODY MUST NOT BE THE SAME SENTENCE. Passing one string to both rendered
  // the paragraph twice in the email. The hero is the one-line statement of WHAT happened; the
  // body carries the detail that does not fit there.
  const heroSubtext = isInvitedDecline
    ? `${clientCompanyName} withdrew your invitation.` // pending-MJ
    : `${clientCompanyName} decided not to proceed with your track on this request.`; // pending-MJ
  const bodyText = isInvitedDecline
    ? 'Nothing was shared with you beyond the brief, and there is nothing further to do here.' // pending-MJ
    : 'The files you had access to stay exactly as they were, and there is nothing further to do here.'; // pending-MJ

  return (
    <ProjectStatusEmail
      previewText={
        isInvitedDecline
          ? `${clientCompanyName} withdrew an invitation: ${projectTitle}`
          : `${clientCompanyName} isn't proceeding with you: ${projectTitle}`
      }
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="Not proceeding"
      heroHeading={isInvitedDecline ? 'This invitation was withdrawn.' : "This isn't proceeding."}
      heroSubtext={heroSubtext}
      bodyText={bodyText}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="No action is needed. If a similar opportunity comes up, you'll hear about it the same way you heard about this one."
      ctaLabel="View request →"
      supportPrefix="Questions about this?"
    />
  );
}
