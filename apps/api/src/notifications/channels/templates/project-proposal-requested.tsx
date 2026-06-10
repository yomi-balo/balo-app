import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Expert email — the client requested this expert's formal proposal (BAL-272 /
 * A5). A commit moment in the conversation, so it is email-worthy. CTA links to
 * the request-detail page where the proposal builder (A6) lives. Layout lives in
 * the shared `ProjectStatusEmail`; only copy varies. No client contact name in
 * the payload or template — contact gating stays server-side.
 */
export function ProjectProposalRequestedEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectEmailRecipientProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, the client wants your proposal: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📋 Proposal requested"
      heroHeading="The client wants your proposal."
      heroSubtext="The conversation is turning into a commitment."
      bodyText="Good news — the client you've been talking with asked you to put together a formal proposal: scope, deliverables, and price. Open the conversation to build it."
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="A sharp, specific proposal keeps the momentum you've built. Lay out deliverables, exclusions, terms, and your payment schedule — you can keep messaging and meeting while you build it."
      ctaLabel="Build your proposal →"
      supportPrefix="Questions about proposals?"
    />
  );
}
