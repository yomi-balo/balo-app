import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

/**
 * BAL-334 / BAL-338 — shared layout + tokens for the CLIENT-facing project-review
 * email family (`.claude/design-references/email-project-review.jsx`). The three
 * variants share one hero/card/footer shell and the amber↔green review-window block:
 *   VARIANT 1 CompletionRequestEmail — engagement-completion-requested.tsx (BAL-334)
 *   VARIANT 2 ReviewReminderEmail    — engagement-review-reminder.tsx      (BAL-338)
 *   VARIANT 3 AutoAcceptedEmail      — engagement-auto-accepted.tsx        (BAL-338)
 *
 * Extracted here so all three implement the design VERBATIM off ONE source (no
 * duplicated shell). Separate from `shared.tsx` (the platform EmailShell family) —
 * this is the bespoke self-contained review layout the design reference specifies.
 * TONE (BAL-329, binding): warm + congratulatory; the auto-accept date/consequence
 * stay unmissable (the window block) but framed as "closed out as delivered so
 * nothing stalls", never a deadline threat. All dates are pre-formatted UTC strings.
 */

// ── Design Tokens (verbatim from the design reference) ────────────
export const reviewColors = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  heroTop: '#1B1A44',
  heroBottom: '#2D2A6E',
};
const c = reviewColors;

/** Review-window tone: amber while a decision is open, green once closed out. */
export type ReviewWindowTone = 'warning' | 'success';

export const reviewStyles: Record<string, CSSProperties> = {
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
    verticalAlign: 'middle',
  },
  logoText: {
    fontSize: '18px',
    fontWeight: '700',
    color: '#FFFFFF',
    verticalAlign: 'middle',
  },
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
  summaryBox: {
    borderRadius: '12px',
    border: `1px solid ${c.border}`,
    margin: '24px 0',
    overflow: 'hidden',
  },
  summaryHeader: {
    padding: '12px 18px',
    background: c.bg,
    borderBottom: `1px solid ${c.border}`,
    fontSize: '11px',
    fontWeight: '700',
    color: c.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
  },
  summaryRow: {
    padding: '11px 18px',
    borderBottom: `1px solid ${c.border}`,
  },
  summaryRowLast: {
    padding: '11px 18px',
  },
  summaryLabel: {
    fontSize: '12px',
    color: c.textTertiary,
    margin: '0 0 2px',
  },
  summaryValue: {
    fontSize: '13.5px',
    fontWeight: '600',
    color: c.text,
    margin: 0,
  },
  ctaWrapper: {
    textAlign: 'center',
    margin: '26px 0 8px',
  },
  ctaPrimary: {
    background: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
    borderRadius: '10px',
    color: '#FFFFFF',
    fontSize: '14px',
    fontWeight: '650',
    padding: '12px 28px',
    textDecoration: 'none',
    display: 'inline-block',
  },
  ctaSecondary: {
    background: c.surface,
    borderRadius: '10px',
    border: `1.5px solid ${c.border}`,
    color: c.textSecondary,
    fontSize: '14px',
    fontWeight: '650',
    padding: '11px 26px',
    textDecoration: 'none',
    display: 'inline-block',
    marginTop: '10px',
  },
  ctaSubline: {
    fontSize: '12px',
    color: c.textTertiary,
    textAlign: 'center',
    margin: '14px 0 0',
    lineHeight: '1.55',
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

/** The signature review-window block — amber while open, green once closed out. */
export function windowBlockStyle(tone: ReviewWindowTone): CSSProperties {
  return {
    padding: '18px 20px',
    borderRadius: '12px',
    background: tone === 'success' ? c.successLight : c.warningLight,
    border: `1.5px solid ${tone === 'success' ? c.successBorder : c.warningBorder}`,
    margin: '24px 0',
    textAlign: 'center',
  };
}

export function windowKickerStyle(tone: ReviewWindowTone): CSSProperties {
  return {
    fontSize: '11px',
    fontWeight: '700',
    color: tone === 'success' ? c.success : c.warning,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    margin: '0 0 6px',
  };
}

export const windowHeadlineStyle: CSSProperties = {
  fontSize: '17px',
  fontWeight: '700',
  color: c.text,
  margin: '0 0 6px',
  lineHeight: '1.4',
};

export const windowTextStyle: CSSProperties = {
  fontSize: '13px',
  color: c.textSecondary,
  margin: 0,
  lineHeight: '1.6',
};

interface ReviewEmailLayoutProps {
  readonly preview: string;
  readonly pill: string;
  readonly heading: string;
  readonly subtext: string;
  readonly children: ReactNode;
}

/** html > head (fonts) > preview > body > container > hero(logo/pill/heading/subtext) > card > footer. */
export function ReviewEmailLayout({
  preview,
  pill,
  heading,
  subtext,
  children,
}: ReviewEmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        `}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={reviewStyles.body}>
        <Container style={reviewStyles.container}>
          <Section style={reviewStyles.hero}>
            <Row>
              <Column align="center">
                {/* CSS inline-block layout (no table) — matches shared.tsx LogoRow */}
                <div style={reviewStyles.logoBadge}>B</div>
                <span style={{ ...reviewStyles.logoText, paddingLeft: '9px' }}>Balo</span>
              </Column>
            </Row>
            <Row style={{ marginTop: '20px' }}>
              <Column align="center">
                <span style={reviewStyles.statusPill}>{pill}</span>
              </Column>
            </Row>
            <Heading style={reviewStyles.heroHeading}>{heading}</Heading>
            <Text style={reviewStyles.heroSubtext}>{subtext}</Text>
          </Section>
          <Section style={reviewStyles.card}>{children}</Section>
          <Section style={reviewStyles.footer}>
            <Text style={reviewStyles.footerText}>
              © {new Date().getFullYear()} Balo Technologies Pty Ltd · Melbourne, Australia
            </Text>
            <Text style={reviewStyles.footerText}>
              <Link href="https://balo.expert/legal/privacy" style={reviewStyles.footerLink}>
                Privacy Policy
              </Link>
              {' · '}
              <Link href="https://balo.expert/legal/terms" style={reviewStyles.footerLink}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Count-aware milestone phrasing for the review email family. The retainer seam lets
 * a ZERO-milestone engagement reach completion, so every count-bearing string must
 * read naturally at 0 / 1 / N — never "all 0 milestones". The zero case drops the
 * count and mirrors the workspace's "no milestones" framing, kept warm for the
 * client's happiest email.
 */
export function milestonePhrases(total: number): {
  readonly previewLead: string;
  readonly subtextLead: string;
  readonly bodyClause: string;
  readonly planValue: string;
  /** "All 4 milestones are done" | "The milestone is done" | "" (drop). */
  readonly doneClause: string;
  /** "all 4 milestones were delivered along the way" | "the milestone was delivered along the way" | "". */
  readonly deliveredAlongClause: string;
} {
  if (total <= 0) {
    return {
      previewLead: 'marked the project complete',
      subtextLead: 'wrapped up the work',
      bodyClause: '',
      planValue: 'No milestones',
      doneClause: '',
      deliveredAlongClause: '',
    };
  }
  if (total === 1) {
    return {
      previewLead: 'delivered the milestone',
      subtextLead: 'delivered every milestone',
      bodyClause: 'the milestone delivered',
      planValue: '1 milestone delivered',
      doneClause: 'The milestone is done',
      deliveredAlongClause: 'the milestone was delivered along the way',
    };
  }
  return {
    previewLead: `delivered all ${total} milestones`,
    subtextLead: 'delivered every milestone',
    bodyClause: `all ${total} milestones delivered`,
    planValue: `All ${total} milestones delivered`,
    doneClause: `All ${total} milestones are done`,
    deliveredAlongClause: `all ${total} milestones were delivered along the way`,
  };
}

interface ProjectSummaryProps {
  readonly projectTitle: string;
  readonly expertParty: string;
  readonly deliveryPlanValue: string;
  readonly requestedDate: string;
}

/** The "The project" summary box (VARIANT 1 only in the design reference). */
export function ProjectSummary({
  projectTitle,
  expertParty,
  deliveryPlanValue,
  requestedDate,
}: ProjectSummaryProps) {
  return (
    <Section style={reviewStyles.summaryBox}>
      <div style={reviewStyles.summaryHeader}>The project</div>
      <div style={reviewStyles.summaryRow}>
        <p style={reviewStyles.summaryLabel}>Project</p>
        <p style={reviewStyles.summaryValue}>{projectTitle}</p>
      </div>
      <div style={reviewStyles.summaryRow}>
        <p style={reviewStyles.summaryLabel}>Delivered by</p>
        <p style={reviewStyles.summaryValue}>{expertParty}</p>
      </div>
      <div style={reviewStyles.summaryRowLast}>
        <p style={reviewStyles.summaryLabel}>Delivery plan</p>
        <p style={reviewStyles.summaryValue}>
          {deliveryPlanValue} · marked complete {requestedDate}
        </p>
      </div>
    </Section>
  );
}

interface DualCtaProps {
  readonly engagementUrl: string;
}

/** The accept / request-changes dual CTA (VARIANT 1 + VARIANT 2). Deep-links carry the
 * `?action=` param the workspace consumes to auto-open the matching modal (BAL-338). */
export function DualCta({ engagementUrl }: DualCtaProps) {
  return (
    <>
      <Section style={reviewStyles.ctaWrapper}>
        <Button style={reviewStyles.ctaPrimary} href={`${engagementUrl}?action=accept`}>
          Accept project →
        </Button>
        <br />
        <Button style={reviewStyles.ctaSecondary} href={`${engagementUrl}?action=request-changes`}>
          Request changes
        </Button>
      </Section>
      <Text style={reviewStyles.ctaSubline}>
        Accepting confirms delivery as agreed — Balo takes care of the final invoice from there.
        Both buttons open your delivery workspace, where the full plan and delivery notes live.
      </Text>
    </>
  );
}
