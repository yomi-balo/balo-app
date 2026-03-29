/**
 * DESIGN REFERENCE — email-application-submitted.jsx
 * BAL-176 · Application confirmation email sent after expert submits application
 *
 * Implementation notes for CC:
 * - This IS the implementation template. Copy to apps/api/src/notifications/templates/
 * - Uses @react-email/components — already installed as part of BAL-175
 * - Rendered via Brevo email adapter (not Resend)
 * - Props: { firstName: string }
 * - Event: expert.application_submitted
 */

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
  Row,
  Column,
} from '@react-email/components';

// ── Design Tokens ────────────────────────────────────────────────
const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  accent: '#7C3AED',
  accentLight: '#F5F3FF',
  accentBorder: '#DDD6FE',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  heroTop: '#1B1A44',
  heroBottom: '#2D2A6E',
};

// ── Styles ───────────────────────────────────────────────────────
const styles = {
  body: {
    backgroundColor: c.bg,
    fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    margin: 0,
    padding: 0,
  },
  container: {
    maxWidth: '560px',
    margin: '0 auto',
    padding: '32px 16px 48px',
  },
  // Hero — more restrained than welcome; conveys "in review" status
  hero: {
    background: `linear-gradient(160deg, ${c.heroTop} 0%, ${c.heroBottom} 100%)`,
    borderRadius: '16px 16px 0 0',
    padding: '32px 40px 28px',
    textAlign: 'center',
  },
  logoBadge: {
    display: 'inline-block',
    width: '32px',
    height: '32px',
    borderRadius: '9px',
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    color: '#FFFFFF',
    fontSize: '14px',
    fontWeight: '700',
    lineHeight: '32px',
    textAlign: 'center',
    marginRight: '9px',
    verticalAlign: 'middle',
  },
  logoText: {
    fontSize: '18px',
    fontWeight: '700',
    color: '#FFFFFF',
    verticalAlign: 'middle',
  },
  // Status pill inside hero
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
    textTransform: 'uppercase',
    marginBottom: '18px',
  },
  heroHeading: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#FFFFFF',
    margin: '0 0 8px',
    lineHeight: '1.3',
    letterSpacing: '-0.3px',
  },
  heroSubtext: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.65)',
    margin: '0',
    lineHeight: '1.55',
  },
  // Body card
  card: {
    backgroundColor: c.surface,
    borderRadius: '0 0 16px 16px',
    border: `1px solid ${c.border}`,
    borderTop: 'none',
    padding: '36px 40px 40px',
  },
  greeting: {
    fontSize: '16px',
    color: c.text,
    fontWeight: '500',
    margin: '0 0 16px',
    lineHeight: '1.6',
  },
  bodyText: {
    fontSize: '15px',
    color: c.textSecondary,
    margin: '0 0 18px',
    lineHeight: '1.65',
  },
  // Timeline steps
  timelineWrapper: {
    margin: '28px 0',
    borderRadius: '12px',
    border: `1px solid ${c.border}`,
    overflow: 'hidden',
  },
  timelineHeader: {
    padding: '12px 18px',
    background: c.bg,
    borderBottom: `1px solid ${c.border}`,
    fontSize: '11px',
    fontWeight: '700',
    color: c.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
  },
  timelineRow: {
    padding: '14px 18px',
    borderBottom: `1px solid ${c.border}`,
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
  },
  timelineRowLast: {
    padding: '14px 18px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
  },
  stepDot: (active) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: active ? c.success : c.border,
    flexShrink: 0,
    marginTop: '5px',
  }),
  stepLabel: (active) => ({
    fontSize: '13px',
    fontWeight: '600',
    color: active ? c.text : c.textTertiary,
    margin: '0 0 2px',
  }),
  stepSub: {
    fontSize: '12px',
    color: c.textTertiary,
    margin: 0,
  },
  // "Use as client" callout
  callout: {
    padding: '16px 18px',
    borderRadius: '10px',
    background: c.accentLight,
    border: `1px solid ${c.accentBorder}`,
    margin: '24px 0',
  },
  calloutHeading: {
    fontSize: '13px',
    fontWeight: '700',
    color: c.accent,
    margin: '0 0 5px',
  },
  calloutText: {
    fontSize: '13px',
    color: c.textSecondary,
    margin: 0,
    lineHeight: '1.55',
  },
  // CTA
  ctaWrapper: {
    textAlign: 'center',
    margin: '24px 0 20px',
  },
  ctaButton: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    borderRadius: '10px',
    color: '#FFFFFF',
    fontSize: '14px',
    fontWeight: '650',
    padding: '12px 28px',
    textDecoration: 'none',
    display: 'inline-block',
  },
  divider: {
    borderColor: c.border,
    margin: '24px 0',
  },
  footer: {
    textAlign: 'center',
    padding: '0 16px',
    marginTop: '24px',
  },
  footerText: {
    fontSize: '12px',
    color: c.textTertiary,
    lineHeight: '1.6',
    margin: '0 0 8px',
  },
  footerLink: {
    color: c.textTertiary,
    textDecoration: 'underline',
  },
};

// ── Timeline steps data ───────────────────────────────────────────
// Step 1 is always complete (they just submitted)
const TIMELINE_STEPS = [
  {
    label: 'Application submitted',
    sub: 'Done — we have your details',
    active: true,
  },
  {
    label: 'Admin review',
    sub: 'Typically within 2–3 business days',
    active: false,
  },
  {
    label: 'Interview',
    sub: 'A short call with our team to verify your expertise',
    active: false,
  },
  {
    label: 'Decision & onboarding',
    sub: 'Approval email with next steps, or feedback if not approved',
    active: false,
  },
  {
    label: 'Go live on the marketplace',
    sub: 'Complete your profile and start accepting bookings',
    active: false,
    last: true,
  },
];

// ── Template ─────────────────────────────────────────────────────

export function ApplicationSubmittedEmail({ firstName = 'there' }) {
  const previewText = `Application received, ${firstName}. Our team will review it within 2–3 business days.`;

  return (
    <Html lang="en" dir="ltr">
      <Head>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        `}</style>
      </Head>
      <Preview>{previewText}</Preview>

      <Body style={styles.body}>
        <Container style={styles.container}>
          {/* ── Hero ── */}
          <Section style={styles.hero}>
            {/* Logo */}
            <Row>
              <Column align="center">
                <table cellPadding={0} cellSpacing={0} style={{ display: 'inline-table' }}>
                  <tr>
                    <td>
                      <div style={styles.logoBadge}>B</div>
                    </td>
                    <td style={{ paddingLeft: 9 }}>
                      <span style={styles.logoText}>Balo</span>
                    </td>
                  </tr>
                </table>
              </Column>
            </Row>

            {/* Status pill */}
            <Row style={{ marginTop: '20px' }}>
              <Column align="center">
                <span style={styles.statusPill}>⏳ Under Review</span>
              </Column>
            </Row>

            <Heading style={styles.heroHeading}>Application received, {firstName}.</Heading>
            <Text style={styles.heroSubtext}>We'll be in touch within 2–3 business days.</Text>
          </Section>

          {/* ── Body card ── */}
          <Section style={styles.card}>
            <Text style={styles.greeting}>Hi {firstName},</Text>
            <Text style={styles.bodyText}>
              Thanks for applying to join Balo as an expert. We review every application personally
              to maintain the quality of our network — here's what happens next.
            </Text>

            {/* Timeline */}
            <Section style={styles.timelineWrapper}>
              <div style={styles.timelineHeader}>What to expect</div>
              {TIMELINE_STEPS.map((step, i) => (
                <div key={i} style={step.last ? styles.timelineRowLast : styles.timelineRow}>
                  <div style={styles.stepDot(step.active)} />
                  <div>
                    <p style={styles.stepLabel(step.active)}>{step.label}</p>
                    <p style={styles.stepSub}>{step.sub}</p>
                  </div>
                </div>
              ))}
            </Section>

            {/* Use as client callout */}
            <Section style={styles.callout}>
              <p style={styles.calloutHeading}>💡 While you wait</p>
              <p style={styles.calloutText}>
                Your Balo account is fully active. You can browse and book consultations with other
                experts on the platform right now — no approval required.
              </p>
            </Section>

            {/* CTA */}
            <Section style={styles.ctaWrapper}>
              <Button style={styles.ctaButton} href="https://balo.expert/experts">
                Browse Experts →
              </Button>
            </Section>

            <Hr style={styles.divider} />

            <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
              Questions about your application? Reply to this email or reach us at{' '}
              <Link href="mailto:support@getbalo.com" style={{ color: c.primary }}>
                support@getbalo.com
              </Link>
              .
            </Text>
          </Section>

          {/* ── Footer ── */}
          <Section style={styles.footer}>
            <Text style={styles.footerText}>
              © {new Date().getFullYear()} Balo Technologies Pty Ltd · Melbourne, Australia
            </Text>
            <Text style={styles.footerText}>
              <Link href="https://balo.expert/legal/privacy" style={styles.footerLink}>
                Privacy Policy
              </Link>
              {' · '}
              <Link href="https://balo.expert/legal/terms" style={styles.footerLink}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default ApplicationSubmittedEmail;
