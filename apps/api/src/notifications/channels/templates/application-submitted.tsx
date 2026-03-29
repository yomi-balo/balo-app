import { Button, Heading, Section, Text } from '@react-email/components';
import type { CSSProperties } from 'react';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';

// ── Application-submitted-specific styles ────────────────────────
const styles = {
  hero: {
    ...shared.heroBase,
    padding: '32px 40px 28px',
  },
  heroHeading: {
    ...shared.heroHeadingBase,
    fontSize: '24px',
    margin: '0 0 8px',
  } as const,
  heroSubtext: {
    ...shared.heroSubtext,
    fontSize: '14px',
  } as const,
  statusPill: {
    display: 'inline-block',
    padding: '5px 14px',
    borderRadius: '20px',
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.2)',
    fontSize: '12px',
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    marginBottom: '18px',
  },
  timelineWrapper: {
    margin: '28px 0',
    borderRadius: '12px',
    border: `1px solid ${colors.border}`,
    overflow: 'hidden' as const,
  },
  timelineHeader: {
    padding: '12px 18px',
    background: colors.bg,
    borderBottom: `1px solid ${colors.border}`,
    fontSize: '11px',
    fontWeight: '700',
    color: colors.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
  },
  timelineRow: {
    padding: '14px 18px',
    borderBottom: `1px solid ${colors.border}`,
    display: 'flex' as const,
    alignItems: 'flex-start',
    gap: '12px',
  },
  timelineRowLast: {
    padding: '14px 18px',
    display: 'flex' as const,
    alignItems: 'flex-start',
    gap: '12px',
  },
  stepSub: {
    fontSize: '12px',
    color: colors.textTertiary,
    margin: 0,
  } as const,
  ctaButton: {
    ...shared.ctaButton,
    fontSize: '14px',
    padding: '12px 28px',
  } as const,
};

function stepDotStyle(active: boolean): CSSProperties {
  return {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: active ? colors.success : colors.border,
    flexShrink: 0,
    marginTop: '5px',
  };
}

function stepLabelStyle(active: boolean): CSSProperties {
  return {
    fontSize: '13px',
    fontWeight: '600',
    color: active ? colors.text : colors.textTertiary,
    margin: '0 0 2px',
  };
}

// ── Timeline steps data ───────────────────────────────────────────
const TIMELINE_STEPS = [
  { label: 'Application submitted', sub: 'Done — we have your details', active: true, last: false },
  { label: 'Admin review', sub: 'Typically within 2–3 business days', active: false, last: false },
  {
    label: 'Interview',
    sub: 'A short call with our team to verify your expertise',
    active: false,
    last: false,
  },
  {
    label: 'Decision & onboarding',
    sub: 'Approval email with next steps, or feedback if not approved',
    active: false,
    last: false,
  },
  {
    label: 'Go live on the marketplace',
    sub: 'Complete your profile and start accepting bookings',
    active: false,
    last: true,
  },
] as const;

// ── Template ─────────────────────────────────────────────────────

interface ApplicationSubmittedEmailProps {
  readonly firstName: string;
  readonly baseUrl: string;
}

export function ApplicationSubmittedEmail({
  firstName = 'there',
  baseUrl,
}: Readonly<ApplicationSubmittedEmailProps>) {
  const previewText = `Application received, ${firstName}. Our team will review it within 2–3 business days.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow size="small" />
        <StatusPill label="⏳ Under Review" style={styles.statusPill} />
        <Heading style={styles.heroHeading}>Application received, {firstName}.</Heading>
        <Text style={styles.heroSubtext}>We'll be in touch within 2–3 business days.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Thanks for applying to join Balo as an expert. We review every application personally to
          maintain the quality of our network — here's what happens next.
        </Text>

        {/* Timeline */}
        <Section style={styles.timelineWrapper}>
          <div style={styles.timelineHeader}>What to expect</div>
          {TIMELINE_STEPS.map((step) => (
            <div key={step.label} style={step.last ? styles.timelineRowLast : styles.timelineRow}>
              <div style={stepDotStyle(step.active)} />
              <div>
                <p style={stepLabelStyle(step.active)}>{step.label}</p>
                <p style={styles.stepSub}>{step.sub}</p>
              </div>
            </div>
          ))}
        </Section>

        <Callout
          emoji="💡"
          heading="While you wait"
          text="Your Balo account is fully active. You can browse and book consultations with other experts on the platform right now — no approval required."
          bg={colors.accentLight}
          borderColor={colors.accentBorder}
          headingColor={colors.accent}
        />

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={styles.ctaButton} href={`${baseUrl}/experts`}>
            Browse Experts →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your application?" />
      </Section>
    </EmailShell>
  );
}
