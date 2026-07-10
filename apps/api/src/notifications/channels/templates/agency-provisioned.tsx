import { shared } from './shared.js';
import { PartyJoinEmail } from './party-domain-join.js';

/**
 * Agency-provisioned owner email (BAL-348). A corporate expert just provisioned a
 * new agency and became its owner. COMPOSES the exported `PartyJoinEmail` shell (hero
 * + body card + Callout + optional CTA + SupportFooter) rather than hand-rolling a
 * fresh `EmailShell` — reusing the shipped shell keeps Sonar's new-code duplication
 * gate (>3%) green and keeps the styling in lockstep with the domain-join family.
 *
 * Owner-framed, prospective copy: colleagues who sign up with the email domain will
 * join automatically, and ownership can be transferred later.
 *
 * `firstName` is the owner's own name (supplied by the email adapter's
 * `recipientName`); `teamName` is the agency name (resolver-hydrated `data.agency`).
 */

/** Green success pill matching the shipped `party-join-request-approved` styling. */
const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.18)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#A7F3D0',
};

export interface AgencyProvisionedEmailProps {
  readonly firstName: string;
  readonly teamName: string;
  readonly teamUrl: string;
  readonly baseUrl: string;
}

export function AgencyProvisionedEmail({
  firstName = 'there',
  teamName,
  teamUrl,
  baseUrl,
}: Readonly<AgencyProvisionedEmailProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`Your team ${teamName} is set up on Balo`}
      pillLabel="✅ Team created"
      pillStyle={successPillStyle}
      heroHeading={`Your team ${teamName} is set up`}
      heroSubtext="You're the owner."
      bodyText={`Your team ${teamName} is set up on Balo. Colleagues who sign up with your email domain will join automatically. You can transfer ownership later.`}
      calloutHeading="Manage your team"
      calloutText="Review members and adjust who has access from your team settings at any time."
      supportPrefix="Questions about your team?"
      baseUrl={baseUrl}
      ctaLabel="View your team →"
      ctaHref={teamUrl}
    />
  );
}
