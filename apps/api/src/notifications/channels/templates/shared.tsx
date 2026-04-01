import {
  Body,
  Column,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

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
    fontWeight: '600',
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
  // ── "Small" hero variant (used by status-pill templates) ──
  smallHero: {
    background: `linear-gradient(160deg, ${colors.heroTop} 0%, ${colors.heroBottom} 100%)`,
    borderRadius: '16px 16px 0 0',
    textAlign: 'center' as const,
    padding: '32px 40px 28px',
  },
  smallHeroHeading: {
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: '1.3',
    letterSpacing: '-0.3px',
    fontSize: '24px',
    margin: '0 0 8px',
  } as const,
  smallHeroSubtext: {
    color: 'rgba(255,255,255,0.65)',
    margin: '0',
    lineHeight: '1.55',
    fontSize: '14px',
  } as const,
  smallCtaButton: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    borderRadius: '10px',
    color: '#FFFFFF',
    fontWeight: '600',
    textDecoration: 'none',
    display: 'inline-block',
    fontSize: '14px',
    padding: '12px 28px',
  } as const,
  statusPillBase: {
    display: 'inline-block',
    padding: '5px 14px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    marginBottom: '18px',
  },
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

/** Balo logo badge + text, centered. CSS inline-block layout (no table). */
export function LogoRow({ size = 'default' }: LogoRowProps) {
  const isSmall = size === 'small';
  const badgeSize = isSmall ? '32px' : '36px';

  return (
    <Row>
      <Column align="center">
        <div
          style={{
            display: 'inline-block',
            width: badgeSize,
            height: badgeSize,
            borderRadius: isSmall ? '9px' : '10px',
            background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
            color: '#FFFFFF',
            fontSize: isSmall ? '14px' : '16px',
            fontWeight: '700',
            lineHeight: badgeSize,
            textAlign: 'center' as const,
            verticalAlign: 'middle',
          }}
        >
          B
        </div>
        <span
          style={{
            fontSize: isSmall ? '18px' : '20px',
            fontWeight: '700',
            color: '#FFFFFF',
            verticalAlign: 'middle',
            paddingLeft: isSmall ? '9px' : '10px',
          }}
        >
          Balo
        </span>
      </Column>
    </Row>
  );
}

interface StatusPillProps {
  readonly label: string;
  readonly style?: CSSProperties;
}

/** Pill badge rendered inside the hero section (e.g. "Under Review", "Approved"). */
export function StatusPill({ label, style }: StatusPillProps) {
  return (
    <Row style={{ marginTop: '20px' }}>
      <Column align="center">
        <span style={style}>{label}</span>
      </Column>
    </Row>
  );
}

interface CalloutProps {
  readonly emoji: string;
  readonly heading: string;
  readonly text: string;
  readonly bg: string;
  readonly borderColor: string;
  readonly headingColor: string;
}

/** Colored callout box with emoji heading and body text. */
export function Callout({ emoji, heading, text, bg, borderColor, headingColor }: CalloutProps) {
  return (
    <Section
      style={{
        padding: '16px 18px',
        borderRadius: '10px',
        background: bg,
        border: `1px solid ${borderColor}`,
        margin: '24px 0',
      }}
    >
      <p style={{ fontSize: '13px', fontWeight: '700', color: headingColor, margin: '0 0 5px' }}>
        {emoji} {heading}
      </p>
      <p
        style={{
          fontSize: '13px',
          color: colors.textSecondary,
          margin: 0,
          lineHeight: '1.55',
        }}
      >
        {text}
      </p>
    </Section>
  );
}

interface SupportFooterProps {
  readonly prefix?: string;
}

/** "Questions? Reply to this email..." block with divider. Placed at the bottom of the card. */
export function SupportFooter({ prefix = 'Questions?' }: SupportFooterProps) {
  return (
    <>
      <Hr style={{ ...shared.divider, margin: '24px 0' }} />
      <Text style={{ ...shared.bodyText, fontSize: '13px', margin: 0 }}>
        {prefix} Reply to this email or reach us at{' '}
        <Link href="mailto:support@getbalo.com" style={{ color: colors.primary }}>
          support@getbalo.com
        </Link>
        .
      </Text>
    </>
  );
}
