import { Button, Heading, Section, Text } from '@react-email/components';
import { EmailShell, LogoRow, StatusPill, SupportFooter, shared } from './shared.js';
import { recipientDisplayZone } from './meeting-guest-emails.js';

/**
 * BAL-652 (copy sheet §2) — THE MISSED-CALL EMAIL, ONE COMPONENT FOR BOTH CALLEE SIDES.
 *
 * ⚠ THE SIDES DIFFER ONLY IN COPY, so they share one shell (two near-identical scaffolds would
 * be the duplication shape SonarCloud flags). The subject and body are composed by
 * {@link buildCallMissedCopy}, which the template registry calls, so the wording lives in one
 * place.
 *
 * ⚠ NAMING: the client is told the expert's first name; the expert is told the client company in
 * the subject and the person with their company in the body. Gender-neutral throughout.
 */

const missedCallPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.16)',
  border: '1px solid rgba(217, 119, 6, 0.35)',
  color: '#FDE68A',
};

/**
 * `10:41 (Melbourne time)` — the call's local time in the RECIPIENT's zone, or `10:41 (UTC)` when
 * the zone is missing, invalid, UTC itself or has no city to name. Unparseable instant → `''`.
 *
 * ⚠ EXPLICIT ZONE, NEVER THE HOST'S: a worker's `TZ` is an accident of deployment.
 */
export function formatCallTimeForRecipient(
  iso: string,
  recipientTimezone: string | null | undefined
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const display = recipientDisplayZone(recipientTimezone);
  const timeZone = display === null ? 'UTC' : display.zone;
  const label = display === null ? 'UTC' : `${display.city} time`;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `${time} (${label})`;
}

export interface CallMissedCopyInput {
  readonly calleeSide: 'client' | 'expert';
  readonly callerFirstName: string;
  readonly callerCompanyName: string;
  readonly callerPersonLabel: string;
  readonly caseTitle: string;
  readonly time: string;
}

export interface CallMissedCopy {
  readonly subject: string;
  readonly body: string;
}

/** The email's subject and body for either callee side (copy sheet §2, verbatim). */
export function buildCallMissedCopy(input: Readonly<CallMissedCopyInput>): CallMissedCopy {
  const when = input.time.length > 0 ? ` at ${input.time}` : '';
  if (input.calleeSide === 'client') {
    return {
      subject: `You missed a call from ${input.callerFirstName}`,
      body: `${input.callerFirstName} tried to call you${when} about ${input.caseTitle}. Nothing was charged. Open the case to call back or book a time.`,
    };
  }
  return {
    subject: `You missed a call from ${input.callerCompanyName}`,
    body: `${input.callerPersonLabel} tried to call you${when} about ${input.caseTitle}. Nothing was counted or charged. Open the case to call back.`,
  };
}

export interface CallMissedEmailProps {
  readonly firstName: string;
  readonly heading: string;
  readonly body: string;
  readonly caseUrl: string;
  readonly baseUrl: string;
}

export function CallMissedEmail({
  firstName,
  heading,
  body,
  caseUrl,
  baseUrl,
}: Readonly<CallMissedEmailProps>) {
  return (
    <EmailShell previewText={heading} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Missed call" style={missedCallPillStyle} />
        <Heading style={shared.smallHeroHeading}>{heading}</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{body}</Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={caseUrl}>
            Open case →
          </Button>
        </Section>

        <SupportFooter prefix="Questions?" />
      </Section>
    </EmailShell>
  );
}
