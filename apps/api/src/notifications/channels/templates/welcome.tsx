import { Button, Heading, Section, Text } from '@react-email/components';
import { colors, shared, EmailShell, LogoRow, SupportFooter } from './shared.js';

// ── Welcome-specific styles ──────────────────────────────────────
const styles = {
  hero: {
    ...shared.heroBase,
    padding: '36px 40px 32px',
  },
  heroHeading: {
    ...shared.heroHeadingBase,
    fontSize: '26px',
    margin: '0 0 10px',
    lineHeight: '1.25',
  } as const,
  heroSubtext: {
    ...shared.heroSubtext,
    fontSize: '15px',
    color: 'rgba(255,255,255,0.70)',
  } as const,
  bodyText: {
    ...shared.bodyText,
    margin: '0 0 20px',
  } as const,
  pillsRow: {
    margin: '28px 0',
  },
  pill: {
    display: 'inline-block',
    padding: '8px 14px',
    borderRadius: '8px',
    backgroundColor: colors.primaryLight,
    border: `1px solid ${colors.primaryBorder}`,
    fontSize: '13px',
    fontWeight: '600',
    color: colors.primary,
    marginRight: '8px',
    marginBottom: '8px',
  },
  ctaButton: {
    ...shared.ctaButton,
    fontSize: '15px',
    padding: '13px 32px',
    letterSpacing: '0.01em',
  } as const,
};

// ── Template ─────────────────────────────────────────────────────

interface WelcomeEmailProps {
  readonly firstName: string;
  readonly role: 'client' | 'expert';
  readonly baseUrl: string;
}

export function WelcomeEmail({
  firstName = 'there',
  role = 'client',
  baseUrl,
}: Readonly<WelcomeEmailProps>) {
  const isExpert = role === 'expert';
  const ctaLabel = isExpert ? 'Complete Your Profile' : 'Find an Expert';
  const ctaUrl = isExpert ? `${baseUrl}/onboarding` : `${baseUrl}/experts`;
  const previewText = `Welcome to Balo, ${firstName}! Projects, Quick Starts, and expert consultations — all in one place.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow />
        <Heading style={styles.heroHeading}>
          {isExpert ? `Welcome to the network, ${firstName}.` : `Welcome to Balo, ${firstName}.`}
        </Heading>
        <Text style={styles.heroSubtext}>
          {isExpert
            ? "Your expert application is in. Let's get your profile ready."
            : 'Projects, Quick Starts, and expert consultations — all in one place.'}
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        {isExpert ? (
          <>
            <Text style={styles.bodyText}>
              We've received your expert application and our team is reviewing it. In the meantime,
              you can set up your profile so you're ready to go live the moment you're approved.
            </Text>
            <Text style={styles.bodyText}>
              Getting started takes about 5 minutes — add your photo, set your rate, connect your
              calendar, and configure payouts.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.bodyText}>
              You now have access to Balo's network of vetted Salesforce specialists. Get a scoped
              project delivered, pick up a packaged Quick Start, or jump on a live consultation —
              whatever fits the problem.
            </Text>
            <Text style={styles.bodyText}>
              No procurement overhead. No hourly minimums. Find the right expert and get moving in
              minutes.
            </Text>
          </>
        )}

        {/* Value props — client only */}
        {!isExpert && (
          <Section style={styles.pillsRow}>
            <span style={styles.pill}>Projects</span>
            <span style={styles.pill}>Quick Starts</span>
            <span style={styles.pill}>Consultations</span>
          </Section>
        )}

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '32px 0 28px' }}>
          <Button style={styles.ctaButton} href={ctaUrl}>
            {ctaLabel} →
          </Button>
        </Section>

        <SupportFooter prefix="Questions? We're happy to help." />
      </Section>
    </EmailShell>
  );
}
