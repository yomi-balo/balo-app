import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Non-selected-expert email — the client accepted a DIFFERENT expert's proposal
 * (BAL-289). The gracious counterpart to `ProjectProposalAcceptedEmail` (sent to
 * the winning expert). No client name is surfaced here — the message is about the
 * outcome, kept warm and forward-looking. CTA links back to the request so the
 * expert can see the project list. Layout lives in the shared `ProjectStatusEmail`.
 */
export function ProjectProposalNotSelectedEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectEmailRecipientProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, an update on your proposal: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📋 Proposal update"
      heroHeading="The client chose another proposal."
      heroSubtext="This one didn't go your way — but thank you for proposing."
      bodyText={`Thank you for the proposal you put together. The client chose another expert for this project this time. It's not a reflection of your work — fit, timing, and scope all play a part — and we'd love to see you on the next brief that matches your expertise.`}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="New project requests come through regularly. Keep your profile sharp and your availability current so you're front-of-mind for the next opportunity that fits you."
      ctaLabel="Browse projects →"
      supportPrefix="Questions?"
    />
  );
}
