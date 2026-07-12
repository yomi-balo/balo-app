import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, SupportFooter } from './shared.js';

// ── Onboarding-reminder styles ───────────────────────────────────
const styles = {
  hero: {
    ...shared.heroBase,
    padding: '36px 40px 32px',
  },
  heroHeading: {
    ...shared.heroHeadingBase,
    fontSize: '24px',
    margin: '14px 0 10px',
    lineHeight: '1.28',
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
  ctaButton: {
    ...shared.ctaButton,
    fontSize: '15px',
    padding: '13px 32px',
    letterSpacing: '0.01em',
  } as const,
};

// ── Template ─────────────────────────────────────────────────────

interface OnboardingReminderEmailProps {
  readonly firstName: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/**
 * BAL-374 onboarding-completion reminder. A warm, prospective, gender-neutral
 * nudge sent by the repeatable sweep to users who signed up but didn't finish
 * onboarding. Deliberately names NOTHING beyond the (optional) first name — the
 * recipient may have no org and no name yet (`firstName` falls back to 'there').
 * NO countdown / deadline / "last chance" framing: this is a recovery nudge, not
 * a pressure tactic. One template for all three cadence steps — only the CTA's
 * `?step=N` differs (passed in via `ctaUrl`); the copy never varies by step.
 */
export function OnboardingReminderEmail({
  firstName = 'there',
  ctaUrl,
  baseUrl,
}: Readonly<OnboardingReminderEmailProps>) {
  const previewText = 'Pick up where you left off — no rush.';

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow />
        <Heading style={styles.heroHeading}>Pick up where you left off</Heading>
        <Text style={styles.heroSubtext}>
          Your Balo account is a couple of minutes from ready — no rush.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        <Text style={styles.bodyText}>
          You started setting up your Balo account but didn&apos;t quite finish. It only takes a
          couple of minutes, and there&apos;s no rush — pick up right where you left off whenever it
          suits you.
        </Text>

        <Text style={styles.bodyText}>
          Once you&apos;re set up, you can find the right expert and get moving — Projects, Quick
          Starts, and live consultations, all in one place.
        </Text>

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '32px 0 28px' }}>
          <Button style={styles.ctaButton} href={ctaUrl}>
            Finish setting up →
          </Button>
        </Section>

        <SupportFooter prefix="Need a hand getting set up?" />
      </Section>
    </EmailShell>
  );
}
