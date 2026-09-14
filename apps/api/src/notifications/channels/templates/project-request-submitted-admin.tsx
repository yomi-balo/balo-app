import { OpsRequestEmail, buildSelectionSummary } from './shared.js';

interface ProjectRequestSubmittedAdminEmailProps {
  readonly projectTitle: string;
  readonly companyName: string;
  readonly baseUrl: string;
  readonly tagCount?: number;
  readonly productCount?: number;
  readonly documentCount?: number;
}

/**
 * Internal/ops email — a buyer submitted a DIRECT request (they chose the expert themselves).
 *
 * ⚠ NOT the same message as `project-match-requested`, and deliberately not a reuse of its copy:
 * that one says "unrouted brief needs a match", which would be FALSE here. This request already
 * has an expert; what Balo owes it is triage. Both land on the same board by different routes,
 * and the copy has to say which. The LAYOUT is shared (`OpsRequestEmail`); the words are not.
 *
 * ⚠ Names the COMPANY, never a person — the submitting user is not on the payload and
 * `data.expert` carries an id with no name, so there is nobody to attribute this to without
 * widening the resolver's hydration (which is serialized into every per-channel BullMQ job).
 *
 * ⚠ The CTA points at `/projects?lens=admin`, the real triage board. `project-match-requested`
 * still links to `/admin/project-requests`, which 404s — do not copy that href.
 */
export function ProjectRequestSubmittedAdminEmail({
  projectTitle = 'a new project',
  companyName = 'A client',
  baseUrl,
  tagCount = 0,
  productCount = 0,
  documentCount = 0,
}: Readonly<ProjectRequestSubmittedAdminEmailProps>) {
  return (
    <OpsRequestEmail
      previewText={`New direct request from ${companyName}: ${projectTitle}`}
      baseUrl={baseUrl}
      pillLabel="⚡ Needs triage"
      heroHeading="New direct request needs triage."
      heroSubtext="A client submitted a project and chose their own expert."
      bodyText={`${companyName} submitted a project brief directly to an expert. The expert has been notified too — this one is on the board so we can keep an eye on it while it moves.`}
      cardLabel="Direct request"
      projectTitle={projectTitle}
      companyName={companyName}
      summary={buildSelectionSummary({ tagCount, productCount, documentCount })}
      calloutHeading="Needs triage"
      calloutText="Open the board to read the brief and triage it. The expert already has it, so this is oversight rather than routing."
      ctaLabel="Open triage board →"
      ctaHref={`${baseUrl}/projects?lens=admin`}
      supportPrefix="Questions about this request?"
    />
  );
}
