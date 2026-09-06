import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';
import { REASON_LABEL, readCloseReason } from './close-reason-label.js';

/**
 * Expert email — the request closed while this track was live (BAL-540). REGISTER
 * (pending-MJ): factual, non-adversarial — the client stopped looking, nothing is asked of the
 * expert. Prospective copy names the PARTY (CLAUDE.md). No CTA that implies further action; the
 * shared shell's CTA still links to the request so the expert can see the ended-track view
 * (files remain, historical-read — ADR-1048).
 */
export function ProjectRequestClosedExpertEmail({
  firstName = 'there',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
  clientCompanyName = 'The client',
}: Readonly<ProjectEmailRecipientProps & { readonly clientCompanyName?: string }>) {
  return (
    <ProjectStatusEmail
      previewText={`${clientCompanyName} isn't proceeding: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="Request closed"
      heroHeading="This request has closed."
      heroSubtext={`${clientCompanyName} has stopped looking for an expert for this work.`}
      bodyText="Your proposal was withdrawn along with the request, and the files you had access to stay exactly as they were. There's nothing further to do here."
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="No action is needed. If a similar opportunity comes up, you'll hear about it the same way you heard about this one."
      ctaLabel="View request →"
      supportPrefix="Questions about this?"
    />
  );
}

/**
 * Client email — Balo closed the request on the client's behalf (BAL-540). The client-closed
 * (self-withdrawal) arm fires no email at all — a toast is enough for an act the client just
 * took themselves; this template exists ONLY for `closedBy: 'balo'`.
 *
 * ⚠ NEVER RENDERS `close_note` — the note is staff-only (D11) and never leaves the DB. Only the
 * CATEGORY (`REASON_LABEL[reason]`).
 */
export function ProjectRequestClosedClientEmail({
  firstName = 'there',
  projectTitle = 'your project',
  projectRequestId,
  baseUrl,
  reason,
}: Readonly<ProjectEmailRecipientProps & { readonly reason?: unknown }>) {
  const reasonLabel = REASON_LABEL[readCloseReason(reason)];
  return (
    <ProjectStatusEmail
      previewText={`We've closed your request: ${projectTitle}`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="Request closed"
      heroHeading="We've closed your request."
      heroSubtext={`Here's why, and what it means.`}
      bodyText={`We closed "${projectTitle}" because ${reasonLabel}.`}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText="Any experts who were on this request have been told, and their access to your shared files stays exactly as it was. You're welcome to start a new request any time."
      ctaLabel="View request →"
      supportPrefix="Questions about this?"
    />
  );
}
