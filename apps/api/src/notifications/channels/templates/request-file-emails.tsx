import { ProjectStatusEmail } from './shared.js';
import { personWithOrgLabel } from '@balo/shared/parties';

/**
 * BAL-431 / ADR-1048 — the two `request_file.shared_with_expert` / `.shared_with_client` email
 * templates. Built on the `ProjectStatusEmail` scaffold (the project family — it already takes
 * `projectRequestId` and links to the request-detail page), so this doesn't hand-roll a third
 * shell.
 *
 * ⚠⚠ NEITHER TEMPLATE MAY NAME THE AUDIENCE, A COUNT, OR ANY SIBLING EXPERT (ADR-1048 §3 binds
 * the notification payload exactly as it binds the expert serializer — "shared with everyone
 * invited" would leak competitor count). ⚠ COUNTERPARTY CONTACT CONCEALMENT (ADR-1044 §3):
 * names cross, addresses never. ⚠ NO MONEY — a file share moves none.
 */

// ── request_file.shared_with_expert ────────────────────────────────────────────────────────

export interface RequestFileSharedExpertEmailProps {
  readonly firstName: string;
  readonly clientCompanyName: string;
  /** Retrospective — a PERSON name, "@ company" on first mention (CLAUDE.md). */
  readonly sharedByPersonLabel: string;
  readonly fileName: string;
  readonly requestTitle: string;
  readonly requestId: string;
  readonly baseUrl: string;
}

export function requestFileSharedExpertSubject(clientCompanyName: string): string {
  return `${clientCompanyName} shared a file with you`;
}

/** BAL-431 — `request-file-shared-expert`. */
export function RequestFileSharedExpertEmail({
  firstName,
  clientCompanyName,
  sharedByPersonLabel,
  fileName,
  requestTitle,
  requestId,
  baseUrl,
}: Readonly<RequestFileSharedExpertEmailProps>) {
  const attribution = personWithOrgLabel(sharedByPersonLabel, clientCompanyName);
  return (
    <ProjectStatusEmail
      previewText={requestFileSharedExpertSubject(clientCompanyName)}
      baseUrl={baseUrl}
      projectRequestId={requestId}
      firstName={firstName}
      pillLabel="📄 New file"
      heroHeading="A new file was shared with you"
      heroSubtext={`${attribution} shared a file on this request.`}
      bodyText={`${attribution} shared "${fileName}" on "${requestTitle}".`}
      summaryLabel="Project request"
      projectTitle={requestTitle}
      calloutText="Open the request to review the file."
      ctaLabel="View request →"
      supportPrefix="Questions about this file?"
    />
  );
}

// ── request_file.shared_with_client ────────────────────────────────────────────────────────

export interface RequestFileSharedClientEmailProps {
  readonly firstName: string;
  /** Prospective — the agency, or an independent expert's own name. */
  readonly expertPartyLabel: string;
  /** Retrospective — the person, "@ agency" on first mention. */
  readonly expertPersonLabel: string;
  readonly fileName: string;
  readonly requestTitle: string;
  readonly requestId: string;
  readonly baseUrl: string;
}

export function requestFileSharedClientSubject(expertPersonLabel: string): string {
  return `${expertPersonLabel} shared a file`;
}

/** BAL-431 — `request-file-shared-client`. */
export function RequestFileSharedClientEmail({
  firstName,
  expertPartyLabel,
  expertPersonLabel,
  fileName,
  requestTitle,
  requestId,
  baseUrl,
}: Readonly<RequestFileSharedClientEmailProps>) {
  const attribution = personWithOrgLabel(expertPersonLabel, expertPartyLabel);
  return (
    <ProjectStatusEmail
      previewText={requestFileSharedClientSubject(expertPersonLabel)}
      baseUrl={baseUrl}
      projectRequestId={requestId}
      firstName={firstName}
      pillLabel="📄 New file"
      heroHeading="A new file was shared"
      heroSubtext={`${attribution} shared a file on this request.`}
      bodyText={`${attribution} shared "${fileName}" on "${requestTitle}".`}
      summaryLabel="Project request"
      projectTitle={requestTitle}
      calloutText="Open the request to review the file."
      ctaLabel="View request →"
      supportPrefix="Questions about this file?"
    />
  );
}
