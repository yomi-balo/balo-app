import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';

/**
 * Domain auto-join emails (BAL-345). One parametrised body shared by all four
 * events so the shells stay in lockstep and Sonar's new-code duplication gate
 * (>3%) stays green — only the copy (and the optional CTA) vary. Bespoke on
 * `EmailShell` (NOT `ProjectStatusEmail`, whose CTA is hardwired): the
 * approve/decline/member-joined variants have no project link.
 *
 * `firstName` is the RECIPIENT's own name (the admin for the two admin-facing
 * events; the requester for approve/decline), supplied by the email adapter's
 * `recipientName`. `actorName` is the SUBJECT (joiner/requester), threaded from
 * the resolver-hydrated `data.user`.
 */

const infoPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.18)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#A7F3D0',
};

const neutralPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(124, 58, 237, 0.18)',
  border: '1px solid rgba(124, 58, 237, 0.35)',
  color: '#DDD6FE',
};

export interface PartyJoinEmailProps {
  readonly firstName: string;
  readonly previewText: string;
  readonly pillLabel: string;
  readonly pillStyle: Record<string, unknown>;
  readonly heroHeading: string;
  readonly heroSubtext: string;
  readonly bodyText: string;
  readonly calloutHeading: string;
  readonly calloutText: string;
  readonly supportPrefix: string;
  readonly baseUrl: string;
  /** Optional CTA — the two admin-facing variants link to the team page. */
  readonly ctaLabel?: string;
  readonly ctaHref?: string;
}

export function PartyJoinEmail({
  firstName = 'there',
  previewText,
  pillLabel,
  pillStyle,
  heroHeading,
  heroSubtext,
  bodyText,
  calloutHeading,
  calloutText,
  supportPrefix,
  baseUrl,
  ctaLabel,
  ctaHref,
}: Readonly<PartyJoinEmailProps>) {
  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={pillLabel} style={pillStyle} />
        <Heading style={shared.smallHeroHeading}>{heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>{heroSubtext}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{bodyText}</Text>

        <Callout
          emoji="💡"
          heading={calloutHeading}
          text={calloutText}
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        {ctaLabel && ctaHref && (
          <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
            <Button style={shared.smallCtaButton} href={ctaHref}>
              {ctaLabel}
            </Button>
          </Section>
        )}

        <SupportFooter prefix={supportPrefix} />
      </Section>
    </EmailShell>
  );
}

/** Names of the two "sides" of a domain-join email. */
export interface PartyJoinRecipientProps {
  readonly firstName: string; // recipient's own name
  readonly actorName: string; // joiner / requester
  readonly partyNoun: string; // "company" | "agency" | "organization"
  readonly teamUrl: string; // link to the team/members page
  readonly baseUrl: string;
}

/** Admins-only FYI that a teammate auto-joined via a matched domain (in-app is primary). */
export function PartyMemberJoinedViaDomainEmail({
  firstName = 'there',
  actorName,
  partyNoun,
  teamUrl,
  baseUrl,
}: Readonly<PartyJoinRecipientProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`${actorName} joined your ${partyNoun} via a matched email domain`}
      pillLabel="👋 New teammate"
      pillStyle={infoPillStyle}
      heroHeading="A teammate just joined"
      heroSubtext="They signed up with your verified email domain."
      bodyText={`${actorName} signed up with an email on your ${partyNoun}'s verified domain and was automatically added as a member. No action is needed — this is a heads-up for your records.`}
      calloutHeading="Manage your team"
      calloutText={`You can review members and adjust who has access from your ${partyNoun}'s team settings at any time.`}
      supportPrefix="Questions about your team?"
      baseUrl={baseUrl}
      ctaLabel="View your team →"
      ctaHref={teamUrl}
    />
  );
}

/** Admins must act: a teammate requested to join via a matched domain. */
export function PartyJoinRequestCreatedEmail({
  firstName = 'there',
  actorName,
  partyNoun,
  teamUrl,
  baseUrl,
}: Readonly<PartyJoinRecipientProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`${actorName} has requested to join your ${partyNoun}`}
      pillLabel="🔔 Approval needed"
      pillStyle={infoPillStyle}
      heroHeading="A teammate wants to join"
      heroSubtext="Review and approve or decline their request."
      bodyText={`${actorName} signed up with an email on your ${partyNoun}'s verified domain and has requested to join. They won't have access until an admin approves the request.`}
      calloutHeading="What happens next"
      calloutText="Approve to add them as a member, or decline if they shouldn't have access. Either way, they'll be notified of your decision."
      supportPrefix="Questions about this request?"
      baseUrl={baseUrl}
      ctaLabel="Review the request →"
      ctaHref={teamUrl}
    />
  );
}

/** Requester (self): their pending request was approved. */
export function PartyJoinRequestApprovedEmail({
  firstName = 'there',
  partyNoun,
  teamUrl,
  baseUrl,
}: Readonly<Omit<PartyJoinRecipientProps, 'actorName'>>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`Your request to join the ${partyNoun} was approved`}
      pillLabel="✅ Request approved"
      pillStyle={successPillStyle}
      heroHeading="You're in"
      heroSubtext="Your request to join has been approved."
      bodyText={`Good news — an admin approved your request to join the ${partyNoun}. You now have member access and can start collaborating with the team.`}
      calloutHeading="Get started"
      calloutText="Head to your workspace to see shared projects and connect with your teammates."
      supportPrefix="Questions?"
      baseUrl={baseUrl}
      ctaLabel="Go to your workspace →"
      ctaHref={teamUrl}
    />
  );
}

/** Requester (self): their pending request was declined. */
export function PartyJoinRequestDeclinedEmail({
  firstName = 'there',
  partyNoun,
  baseUrl,
}: Readonly<Omit<PartyJoinRecipientProps, 'actorName' | 'teamUrl'>>): ReturnType<
  typeof PartyJoinEmail
> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`An update on your request to join the ${partyNoun}`}
      pillLabel="Request declined"
      pillStyle={neutralPillStyle}
      heroHeading="An update on your request"
      heroSubtext="Your request to join was not approved."
      bodyText={`An admin reviewed your request to join the ${partyNoun} and decided not to approve it at this time. You can keep using your own personal workspace as usual.`}
      calloutHeading="What you can do"
      calloutText="If you think this was a mistake, reach out to an admin at your organization — they can add you directly."
      supportPrefix="Questions?"
      baseUrl={baseUrl}
    />
  );
}
