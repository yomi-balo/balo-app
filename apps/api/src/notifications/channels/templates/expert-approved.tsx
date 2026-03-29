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

const approvedPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.2)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#6EE7B7',
};

// ── Template ─────────────────────────────────────────────────────

interface ExpertApprovedEmailProps {
  readonly firstName: string;
  readonly baseUrl: string;
}

export function ExpertApprovedEmail({
  firstName = 'there',
  baseUrl,
}: Readonly<ExpertApprovedEmailProps>) {
  const previewText = `You're approved, ${firstName}! Complete your profile and start accepting bookings on Balo.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="✓ Approved" style={approvedPillStyle} />
        <Heading style={shared.smallHeroHeading}>You're in, {firstName}!</Heading>
        <Text style={shared.smallHeroSubtext}>
          Your expert application has been approved. Welcome to the network.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Great news — our team has reviewed your application and you've been approved as an expert
          on Balo. You're now part of a curated network of Salesforce specialists.
        </Text>
        <Text style={shared.bodyText}>
          To start receiving bookings, complete your profile setup: add a profile photo, set your
          hourly rate, connect your calendar, and configure your payout method. It takes about 5
          minutes.
        </Text>

        <Callout
          emoji="🚀"
          heading="Get started"
          text="Complete your profile and you'll appear in the expert marketplace. Clients can then browse your profile, book consultations, and request projects."
          bg={colors.successLight}
          borderColor={colors.successBorder}
          headingColor={colors.success}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/expert/settings`}>
            Complete Your Profile →
          </Button>
        </Section>

        <SupportFooter />
      </Section>
    </EmailShell>
  );
}
