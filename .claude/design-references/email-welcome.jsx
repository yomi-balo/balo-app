/**
 * DESIGN REFERENCE — email-welcome.jsx
 * BAL-176 · Welcome email sent after new user signup
 *
 * Implementation notes for CC:
 * - This IS the implementation template. Copy to apps/api/src/notifications/templates/
 * - Uses @react-email/components — already installed as part of BAL-175
 * - Rendered via Brevo email adapter (not Resend)
 * - Props: { firstName: string; role: 'client' | 'expert' }
 * - Event: user.welcome
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
  Img,
} from '@react-email/components';

// ── Design Tokens ────────────────────────────────────────────────
const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  accent: '#7C3AED',
  success: '#059669',
  successLight: '#ECFDF5',
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
  // Hero header
  hero: {
    background: `linear-gradient(160deg, ${c.heroTop} 0%, ${c.heroBottom} 100%)`,
    borderRadius: '16px 16px 0 0',
    padding: '36px 40px 32px',
    textAlign: 'center',
  },
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: '28px',
  },
  logoBadge: {
    display: 'inline-block',
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    color: '#FFFFFF',
    fontSize: '16px',
    fontWeight: '700',
    lineHeight: '36px',
    textAlign: 'center',
    marginRight: '10px',
    verticalAlign: 'middle',
  },
  logoText: {
    fontSize: '20px',
    fontWeight: '700',
    color: '#FFFFFF',
    verticalAlign: 'middle',
  },
  heroHeading: {
    fontSize: '26px',
    fontWeight: '700',
    color: '#FFFFFF',
    margin: '0 0 10px',
    lineHeight: '1.25',
    letterSpacing: '-0.3px',
  },
  heroSubtext: {
    fontSize: '15px',
    color: 'rgba(255,255,255,0.70)',
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
    margin: '0 0 20px',
    lineHeight: '1.65',
  },
  // Value prop pills
  pillsRow: {
    margin: '28px 0',
  },
  pill: {
    display: 'inline-block',
    padding: '8px 14px',
    borderRadius: '8px',
    backgroundColor: c.primaryLight,
    border: `1px solid ${c.primaryBorder}`,
    fontSize: '13px',
    fontWeight: '600',
    color: c.primary,
    marginRight: '8px',
    marginBottom: '8px',
  },
  // CTA button
  ctaWrapper: {
    textAlign: 'center',
    margin: '32px 0 28px',
  },
  ctaButton: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    borderRadius: '10px',
    color: '#FFFFFF',
    fontSize: '15px',
    fontWeight: '650',
    padding: '13px 32px',
    textDecoration: 'none',
    display: 'inline-block',
    letterSpacing: '0.01em',
  },
  divider: {
    borderColor: c.border,
    margin: '28px 0',
  },
  // Footer
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

// ── Template ─────────────────────────────────────────────────────

export function WelcomeEmail({ firstName = 'there', role = 'client' }) {
  const isExpert = role === 'expert';

  const ctaLabel = isExpert ? 'Complete Your Profile' : 'Find an Expert';
  const ctaUrl = isExpert ? 'https://balo.expert/onboarding' : 'https://balo.expert/experts';

  const previewText = `Welcome to Balo, ${firstName}! Projects, Quick Starts, and expert consultations — all in one place.`;

  return (
    <Html lang="en" dir="ltr">
      <Head>
        {/* DM Sans via Google Fonts — falls back gracefully in email clients */}
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
                    <td style={{ paddingLeft: 10 }}>
                      <span style={styles.logoText}>Balo</span>
                    </td>
                  </tr>
                </table>
              </Column>
            </Row>

            {/* Heading */}
            <Heading style={styles.heroHeading}>
              {isExpert
                ? `Welcome to the network, ${firstName}.`
                : `Welcome to Balo, ${firstName}.`}
            </Heading>
            <Text style={styles.heroSubtext}>
              {isExpert
                ? "Your expert application is in. Let's get your profile ready."
                : 'Projects, Quick Starts, and expert consultations — all in one place.'}
            </Text>
          </Section>

          {/* ── Body card ── */}
          <Section style={styles.card}>
            <Text style={styles.greeting}>Hi {firstName},</Text>

            {isExpert ? (
              <>
                <Text style={styles.bodyText}>
                  We've received your expert application and our team is reviewing it. In the
                  meantime, you can set up your profile so you're ready to go live the moment you're
                  approved.
                </Text>
                <Text style={styles.bodyText}>
                  Getting started takes about 5 minutes — add your photo, set your rate, connect
                  your calendar, and configure payouts.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.bodyText}>
                  You now have access to Balo's network of vetted Salesforce specialists. Get a
                  scoped project delivered, pick up a packaged Quick Start, or jump on a live
                  consultation — whatever fits the problem.
                </Text>
                <Text style={styles.bodyText}>
                  No procurement overhead. No hourly minimums. Find the right expert and get moving
                  in minutes.
                </Text>
              </>
            )}

            {/* Value props */}
            {!isExpert && (
              <Section style={styles.pillsRow}>
                <span style={styles.pill}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={c.primary}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ verticalAlign: 'middle', marginRight: 5 }}
                  >
                    <rect x="2" y="7" width="20" height="14" rx="2" />
                    <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
                  </svg>
                  Projects
                </span>
                <span style={styles.pill}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={c.primary}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ verticalAlign: 'middle', marginRight: 5 }}
                  >
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  Quick Starts
                </span>
                <span style={styles.pill}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={c.primary}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ verticalAlign: 'middle', marginRight: 5 }}
                  >
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                  Consultations
                </span>
              </Section>
            )}

            {/* CTA */}
            <Section style={styles.ctaWrapper}>
              <Button style={styles.ctaButton} href={ctaUrl}>
                {ctaLabel} →
              </Button>
            </Section>

            <Hr style={styles.divider} />

            <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
              Questions? Reply to this email or reach us at{' '}
              <Link href="mailto:support@getbalo.com" style={{ color: c.primary }}>
                support@getbalo.com
              </Link>
              . We're happy to help.
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

// Named export for React Email preview renderer
export default WelcomeEmail;
