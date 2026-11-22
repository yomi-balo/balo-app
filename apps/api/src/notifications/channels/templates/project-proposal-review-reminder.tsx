import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Adds the number of proposals awaiting review to the shared project-email props. */
export interface ProjectProposalReviewReminderEmailProps extends ProjectEmailRecipientProps {
  readonly awaitingCount: number;
}

/** "1 proposal is ready" / "3 proposals are ready" — never below one. */
export function proposalsReadyPhrase(awaitingCount: number): string {
  return awaitingCount <= 1 ? '1 proposal is ready' : `${awaitingCount} proposals are ready`;
}

/**
 * Client email — the BAL-663 follow-up while proposals still await the client's review. Warm,
 * count-aware, no countdown and no money. CTA links to the request page, where the client
 * reviews each proposal. Layout lives in the shared `ProjectStatusEmail`.
 */
export function ProjectProposalReviewReminderEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  awaitingCount,
  baseUrl,
}: Readonly<ProjectProposalReviewReminderEmailProps>) {
  const ready = proposalsReadyPhrase(awaitingCount);
  const single = awaitingCount <= 1;
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, ${ready} for your review on ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel={single ? '📋 A proposal is waiting' : '📋 Proposals waiting'}
      heroHeading={`${ready} for your review.`}
      heroSubtext="Take a look whenever suits you."
      bodyText={
        single
          ? 'Open the request to read through the scope and deliverables and decide your next step.'
          : 'Open the request to read through the scope and deliverables of each and decide your next step.'
      }
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText={
        single
          ? 'Open the request to ask the expert a question, ask for changes, or accept the proposal when it fits. No rush.'
          : 'Open the request to compare them side by side, ask the experts a question, or accept the one that fits. No rush.'
      }
      ctaLabel={single ? 'Review the proposal →' : 'Review proposals →'}
      supportPrefix={single ? 'Questions about this proposal?' : 'Questions about these proposals?'}
    />
  );
}
