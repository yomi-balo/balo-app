import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
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
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
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
  } as const,
  container: {
    maxWidth: '560px',
    margin: '0 auto',
    padding: '32px 16px 48px',
  } as const,
  hero: {
    background: `linear-gradient(160deg, ${c.heroTop} 0%, ${c.heroBottom} 100%)`,
    borderRadius: '16px 16px 0 0',
    padding: '32px 40px 28px',
    textAlign: 'center' as const,
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
    textAlign: 'center' as const,
    marginRight: '9px',
    verticalAlign: 'middle',
  },
  logoText: {
    fontSize: '18px',
    fontWeight: '700',
    color: '#FFFFFF',
    verticalAlign: 'middle',
  } as const,
  statusPill: {
    display: 'inline-block',
    padding: '5px 14px',
    borderRadius: '20px',
    background: 'rgba(5, 150, 105, 0.2)',
    border: '1px solid rgba(5, 150, 105, 0.35)',
    fontSize: '12px',
    fontWeight: '600',
    color: '#6EE7B7',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    marginBottom: '18px',
  },
  heroHeading: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#FFFFFF',
    margin: '0 0 8px',
    lineHeight: '1.3',
    letterSpacing: '-0.3px',
  } as const,
  heroSubtext: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.65)',
    margin: '0',
    lineHeight: '1.55',
  } as const,
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
  } as const,
  bodyText: {
    fontSize: '15px',
    color: c.textSecondary,
    margin: '0 0 18px',
    lineHeight: '1.65',
  } as const,
  callout: {
    padding: '16px 18px',
    borderRadius: '10px',
    background: c.successLight,
    border: `1px solid ${c.successBorder}`,
    margin: '24px 0',
  },
  calloutHeading: {
    fontSize: '13px',
    fontWeight: '700',
    color: c.success,
    margin: '0 0 5px',
  } as const,
  calloutText: {
    fontSize: '13px',
    color: c.textSecondary,
    margin: 0,
    lineHeight: '1.55',
  } as const,
  ctaWrapper: {
    textAlign: 'center' as const,
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
  } as const,
  divider: {
    borderColor: c.border,
    margin: '24px 0',
  },
  footer: {
    textAlign: 'center' as const,
    padding: '0 16px',
    marginTop: '24px',
  },
  footerText: {
    fontSize: '12px',
    color: c.textTertiary,
    lineHeight: '1.6',
    margin: '0 0 8px',
  } as const,
  footerLink: {
    color: c.textTertiary,
    textDecoration: 'underline',
  },
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

            <Row style={{ marginTop: '20px' }}>
              <Column align="center">
                <span style={styles.statusPill}>✓ Approved</span>
              </Column>
            </Row>

            <Heading style={styles.heroHeading}>You're in, {firstName}!</Heading>
            <Text style={styles.heroSubtext}>
              Your expert application has been approved. Welcome to the network.
            </Text>
          </Section>

          {/* ── Body card ── */}
          <Section style={styles.card}>
            <Text style={styles.greeting}>Hi {firstName},</Text>
            <Text style={styles.bodyText}>
              Great news — our team has reviewed your application and you've been approved as an
              expert on Balo. You're now part of a curated network of Salesforce specialists.
            </Text>
            <Text style={styles.bodyText}>
              To start receiving bookings, complete your profile setup: add a profile photo, set
              your hourly rate, connect your calendar, and configure your payout method. It takes
              about 5 minutes.
            </Text>

            {/* Next steps callout */}
            <Section style={styles.callout}>
              <p style={styles.calloutHeading}>🚀 Get started</p>
              <p style={styles.calloutText}>
                Complete your profile and you'll appear in the expert marketplace. Clients can then
                browse your profile, book consultations, and request projects.
              </p>
            </Section>

            {/* CTA */}
            <Section style={styles.ctaWrapper}>
              <Button style={styles.ctaButton} href={`${baseUrl}/expert/settings`}>
                Complete Your Profile →
              </Button>
            </Section>

            <Hr style={styles.divider} />

            <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
              Questions? Reply to this email or reach us at{' '}
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
              <Link href={`${baseUrl}/legal/privacy`} style={styles.footerLink}>
                Privacy Policy
              </Link>
              {' · '}
              <Link href={`${baseUrl}/legal/terms`} style={styles.footerLink}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
