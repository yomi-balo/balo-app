import { OpsRequestEmail, buildSelectionSummary } from './shared.js';

interface ProjectMatchRequestedEmailProps {
  readonly projectTitle: string;
  readonly companyName: string;
  readonly baseUrl: string;
  readonly tagCount?: number;
  readonly productCount?: number;
  readonly documentCount?: number;
}

/**
 * Internal/ops email — a buyer submitted an UNROUTED brief that needs a manual expert match.
 * The ops team reads the full brief in-product; this is the nudge.
 *
 * ⚠ Layout shared with `project-request-submitted-admin` via `OpsRequestEmail`; the COPY is not,
 * because the two say materially different things (match vs triage).
 */
export function ProjectMatchRequestedEmail({
  projectTitle = 'a new project',
  companyName = 'A client',
  baseUrl,
  tagCount = 0,
  productCount = 0,
  documentCount = 0,
}: Readonly<ProjectMatchRequestedEmailProps>) {
  return (
    <OpsRequestEmail
      previewText={`New unrouted brief from ${companyName}: ${projectTitle}`}
      baseUrl={baseUrl}
      pillLabel="🔍 Needs a match"
      heroHeading="New unrouted brief needs a match."
      heroSubtext="A client submitted a project without choosing an expert."
      bodyText={`${companyName} submitted a project brief and asked us to match them with the right expert. Review the brief and route it to a suitable specialist.`}
      cardLabel="Unrouted project"
      projectTitle={projectTitle}
      companyName={companyName}
      summary={buildSelectionSummary({ tagCount, productCount, documentCount })}
      calloutHeading="Action needed"
      calloutText="Open the ops queue to read the full brief, then match it with an expert. The faster we route it, the better the client experience."
      ctaLabel="Review brief →"
      ctaHref={`${baseUrl}/admin/project-requests`}
      supportPrefix="Questions about this brief?"
    />
  );
}
