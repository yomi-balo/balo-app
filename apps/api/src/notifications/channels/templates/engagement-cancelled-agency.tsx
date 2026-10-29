import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-631 — a project one of the agency's experts was delivering was cancelled; the agency's
 * owners and admins are notified. Same structure as `engagement-cancelled.tsx`, but written for
 * the agency (names the delivering expert and client, makes no billing or milestone claim) and
 * its CTA deep-links to the delivery workspace with `?from=agency` so the back link returns to
 * the Agency lens. The optional names drop their clauses when the publisher omitted them.
 */
export interface EngagementCancelledAgencyEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly cancelledOn: string;
  readonly engagementId: string;
  readonly baseUrl: string;
  readonly deliveringExpertName?: string;
  readonly deliveringAgencyName?: string;
  readonly clientCompanyName?: string;
  readonly actorLabel?: string;
}

const cancelledPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(220, 38, 38, 0.16)',
  border: '1px solid rgba(220, 38, 38, 0.32)',
  color: '#FCA5A5',
};

/** The email's preheader: who was delivering, and at which agency when both are known. */
function buildPreheader(
  projectTitle: string,
  expert: string | undefined,
  agency: string | undefined
): string {
  if (expert && agency) return `Delivered by ${expert} at ${agency}.`;
  if (expert) return `Delivered by ${expert}.`;
  return `${projectTitle} has been cancelled`;
}

/**
 * Line 2 of the body. The deliverer and client clauses are joined into one optional phrase, so no
 * combination leaves a stray comma: "'X' was cancelled", "'X' for C was cancelled",
 * "'X', the project P was delivering, was cancelled" or "... delivering for C, was cancelled".
 */
function buildBodyLine(props: Readonly<EngagementCancelledAgencyEmailProps>): string {
  const { projectTitle, cancelledOn, deliveringExpertName, clientCompanyName, actorLabel } = props;
  const forClient = clientCompanyName ? ` for ${clientCompanyName}` : '';
  const leadIn = deliveringExpertName
    ? `, the project ${deliveringExpertName} was delivering${forClient},`
    : forClient;
  const cancelledBy = actorLabel ? ` It was cancelled by ${actorLabel}.` : '';
  return `'${projectTitle}'${leadIn} was cancelled on ${cancelledOn}.${cancelledBy}`;
}

export function EngagementCancelledAgencyEmail(
  props: Readonly<EngagementCancelledAgencyEmailProps>
): React.JSX.Element {
  const { firstName, projectTitle, engagementId, baseUrl, deliveringAgencyName } = props;
  const agencyLabel = deliveringAgencyName ?? 'your agency';
  return (
    <EmailShell
      previewText={buildPreheader(projectTitle, props.deliveringExpertName, deliveringAgencyName)}
      baseUrl={baseUrl}
    >
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Project cancelled" style={cancelledPillStyle} />
        <Heading style={shared.smallHeroHeading}>This project has been cancelled.</Heading>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{buildBodyLine(props)}</Text>
        <Text style={shared.bodyText}>
          {`Nothing more is needed from ${agencyLabel} unless you'd like to follow up with the team.`}
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button
            style={shared.smallCtaButton}
            href={`${baseUrl}/engagements/${engagementId}?from=agency`}
          >
            View the project
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this cancellation?" />
      </Section>
    </EmailShell>
  );
}
