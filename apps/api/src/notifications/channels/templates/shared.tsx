import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
export const colors = {
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
  heroTop: '#1B1A44',
  heroBottom: '#2D2A6E',
};

// ── Shared Styles ────────────────────────────────────────────────
export const shared = {
  body: {
    backgroundColor: colors.bg,
    fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    margin: 0,
    padding: 0,
  } as const,
  container: {
    maxWidth: '560px',
    margin: '0 auto',
    padding: '32px 16px 48px',
  } as const,
  heroBase: {
    background: `linear-gradient(160deg, ${colors.heroTop} 0%, ${colors.heroBottom} 100%)`,
    borderRadius: '16px 16px 0 0',
    textAlign: 'center' as const,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: '0 0 16px 16px',
    border: `1px solid ${colors.border}`,
    borderTop: 'none',
    padding: '36px 40px 40px',
  },
  greeting: {
    fontSize: '16px',
    color: colors.text,
    fontWeight: '500',
    margin: '0 0 16px',
    lineHeight: '1.6',
  } as const,
  bodyText: {
    fontSize: '15px',
    color: colors.textSecondary,
    margin: '0 0 18px',
    lineHeight: '1.65',
  } as const,
  ctaWrapper: {
    textAlign: 'center' as const,
  },
  ctaButton: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    borderRadius: '10px',
    color: '#FFFFFF',
    fontWeight: '650',
    textDecoration: 'none',
    display: 'inline-block',
  } as const,
  heroHeadingBase: {
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: '1.3',
    letterSpacing: '-0.3px',
  } as const,
  heroSubtext: {
    color: 'rgba(255,255,255,0.65)',
    margin: '0',
    lineHeight: '1.55',
  } as const,
  divider: {
    borderColor: colors.border,
  },
  footer: {
    textAlign: 'center' as const,
    padding: '0 16px',
    marginTop: '24px',
  },
  footerText: {
    fontSize: '12px',
    color: colors.textTertiary,
    lineHeight: '1.6',
    margin: '0 0 8px',
  } as const,
  footerLink: {
    color: colors.textTertiary,
    textDecoration: 'underline',
  },
};

// ── Shared Layout Components ─────────────────────────────────────

interface EmailShellProps {
  readonly previewText: string;
  readonly baseUrl: string;
  readonly children: ReactNode;
}

/** Wraps every Balo email: html > head (fonts) > preview > body > container > {children} > footer */
export function EmailShell({ previewText, baseUrl, children }: EmailShellProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        `}</style>
      </Head>
      <Preview>{previewText}</Preview>

      <Body style={shared.body}>
        <Container style={shared.container}>
          {children}

          {/* ── Footer ── */}
          <Section style={shared.footer}>
            <Text style={shared.footerText}>
              © {new Date().getFullYear()} Balo Technologies Pty Ltd · Melbourne, Australia
            </Text>
            <Text style={shared.footerText}>
              <Link href={`${baseUrl}/legal/privacy`} style={shared.footerLink}>
                Privacy Policy
              </Link>
              {' · '}
              <Link href={`${baseUrl}/legal/terms`} style={shared.footerLink}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

interface LogoRowProps {
  readonly size?: 'default' | 'small';
}

/** Balo logo badge + text, centered in a table row. */
export function LogoRow({ size = 'default' }: LogoRowProps) {
  const badgeSize = size === 'small' ? '32px' : '36px';
  const fontSize = size === 'small' ? '14px' : '16px';
  const textSize = size === 'small' ? '18px' : '20px';
  const gap = size === 'small' ? 9 : 10;

  return (
    <Row>
      <Column align="center">
        <table cellPadding={0} cellSpacing={0} style={{ display: 'inline-table' }}>
          <tr>
            <td>
              <div
                style={{
                  display: 'inline-block',
                  width: badgeSize,
                  height: badgeSize,
                  borderRadius: size === 'small' ? '9px' : '10px',
                  background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
                  color: '#FFFFFF',
                  fontSize,
                  fontWeight: '700',
                  lineHeight: badgeSize,
                  textAlign: 'center' as const,
                  verticalAlign: 'middle',
                }}
              >
                B
              </div>
            </td>
            <td style={{ paddingLeft: gap }}>
              <span
                style={{
                  fontSize: textSize,
                  fontWeight: '700',
                  color: '#FFFFFF',
                  verticalAlign: 'middle',
                }}
              >
                Balo
              </span>
            </td>
          </tr>
        </table>
      </Column>
    </Row>
  );
}
