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
import type { CSSProperties, ReactNode } from 'react';

/**
 * BAL-334 (D4) — `CompletionRequestEmail` (VARIANT 1 of the project-review email
 * family), sent to the CLIENT company owner when the delivering expert marks the
 * whole project complete. Implemented VERBATIM (layout AND copy) from the design
 * reference `.claude/design-references/email-project-review.jsx` VARIANT 1 — the
 * reminder (VARIANT 2) and auto-accepted (VARIANT 3) variants are BAL-338 and are
 * NOT built here.
 *
 * TONE (BAL-329, binding): warm + congratulatory — completion is the happiest email
 * a client gets. Celebrate first; the auto-accept date and consequence stay
 * unmissable (the window block) but framed as "we close it out as delivered so
 * nothing stalls", never a deadline threat. Prospective copy names the PARTY
 * (`clientCompany` / `expertParty`); retrospective copy names the PERSON with
 * "@ company/agency" on first mention (`actorExpert`). All dates are pre-formatted
 * UTC strings — no date logic here.
 */

// ── Design Tokens (same set as the design reference) ──────────────
const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  heroTop: '#1B1A44',
  heroBottom: '#2D2A6E',
};

// ── Styles (VARIANT 1 uses the warning-tone window block only) ────
const styles: Record<string, CSSProperties> = {
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
  windowBlock: {
    padding: '18px 20px',
    borderRadius: '12px',
    background: c.warningLight,
    border: `1.5px solid ${c.warningBorder}`,
    margin: '24px 0',
    textAlign: 'center',
  },
  windowKicker: {
    fontSize: '11px',
    fontWeight: '700',
    color: c.warning,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    margin: '0 0 6px',
  },
  windowHeadline: {
    fontSize: '17px',
    fontWeight: '700',
    color: c.text,
    margin: '0 0 6px',
    lineHeight: '1.4',
  },
  windowText: {
    fontSize: '13px',
    color: c.textSecondary,
    margin: 0,
    lineHeight: '1.6',
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

interface ReviewEmailLayoutProps {
  readonly preview: string;
  readonly pill: string;
  readonly heading: string;
  readonly subtext: string;
  readonly children: ReactNode;
}

function ReviewEmailLayout({ preview, pill, heading, subtext, children }: ReviewEmailLayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        `}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.hero}>
            <Row>
              <Column align="center">
                <table
                  role="presentation"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ display: 'inline-table' }}
                >
                  <tbody>
                    <tr>
                      <td>
                        <div style={styles.logoBadge}>B</div>
                      </td>
                      <td style={{ paddingLeft: 9 }}>
                        <span style={styles.logoText}>Balo</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </Column>
            </Row>
            <Row style={{ marginTop: '20px' }}>
              <Column align="center">
                <span style={styles.statusPill}>{pill}</span>
              </Column>
            </Row>
            <Heading style={styles.heroHeading}>{heading}</Heading>
            <Text style={styles.heroSubtext}>{subtext}</Text>
          </Section>
          <Section style={styles.card}>{children}</Section>
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

/**
 * Count-aware milestone phrasing for the completion email. The retainer seam lets a
 * ZERO-milestone engagement reach completion (engagementsRepository.requestCompletion
 * passes the milestone guard vacuously → pending_acceptance → this email with
 * milestonesTotal === 0), so every count-bearing string must read naturally at 0 / 1 / N
 * — never "all 0 milestones" or "all 1 milestones". The zero case drops the count
 * entirely and mirrors the workspace's "no milestones" framing (deriveCompletionCard /
 * deriveEmptyState in engagement-view.ts), kept warm for the client's happiest email.
 */
export function milestonePhrases(total: number): {
  readonly previewLead: string;
  readonly subtextLead: string;
  readonly bodyClause: string;
  readonly planValue: string;
} {
  if (total <= 0) {
    return {
      previewLead: 'marked the project complete',
      subtextLead: 'wrapped up the work',
      bodyClause: '',
      planValue: 'No milestones',
    };
  }
  if (total === 1) {
    return {
      previewLead: 'delivered the milestone',
      subtextLead: 'delivered every milestone',
      bodyClause: 'the milestone delivered',
      planValue: '1 milestone delivered',
    };
  }
  return {
    previewLead: `delivered all ${total} milestones`,
    subtextLead: 'delivered every milestone',
    bodyClause: `all ${total} milestones delivered`,
    planValue: `All ${total} milestones delivered`,
  };
}

interface ProjectSummaryProps {
  readonly projectTitle: string;
  readonly expertParty: string;
  readonly deliveryPlanValue: string;
  readonly requestedDate: string;
}

function ProjectSummary({
  projectTitle,
  expertParty,
  deliveryPlanValue,
  requestedDate,
}: ProjectSummaryProps) {
  return (
    <Section style={styles.summaryBox}>
      <div style={styles.summaryHeader}>The project</div>
      <div style={styles.summaryRow}>
        <p style={styles.summaryLabel}>Project</p>
        <p style={styles.summaryValue}>{projectTitle}</p>
      </div>
      <div style={styles.summaryRow}>
        <p style={styles.summaryLabel}>Delivered by</p>
        <p style={styles.summaryValue}>{expertParty}</p>
      </div>
      <div style={styles.summaryRowLast}>
        <p style={styles.summaryLabel}>Delivery plan</p>
        <p style={styles.summaryValue}>
          {deliveryPlanValue} · marked complete {requestedDate}
        </p>
      </div>
    </Section>
  );
}

interface DualCtaProps {
  readonly engagementUrl: string;
}

function DualCta({ engagementUrl }: DualCtaProps) {
  return (
    <>
      <Section style={styles.ctaWrapper}>
        <Button style={styles.ctaPrimary} href={`${engagementUrl}?action=accept`}>
          Accept project →
        </Button>
        <br />
        <Button style={styles.ctaSecondary} href={`${engagementUrl}?action=request-changes`}>
          Request changes
        </Button>
      </Section>
      <Text style={styles.ctaSubline}>
        Accepting confirms delivery as agreed — Balo takes care of the final invoice from there.
        Both buttons open your delivery workspace, where the full plan and delivery notes live.
      </Text>
    </>
  );
}

export interface CompletionRequestEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly expertParty: string;
  readonly actorExpert: string;
  readonly projectTitle: string;
  readonly milestonesTotal: number;
  readonly requestedDate: string;
  readonly autoDate: string;
  readonly reviewDays: number;
  readonly engagementUrl: string;
}

/**
 * VARIANT 1 — Completion request (engagement.completion_requested).
 * Subject: "Great news — {projectTitle} is complete 🎉"
 */
export function CompletionRequestEmail({
  firstName = 'there',
  clientCompany = 'your team',
  expertParty = 'Your expert',
  actorExpert = 'Your expert',
  projectTitle = 'your project',
  milestonesTotal = 0,
  requestedDate,
  autoDate,
  reviewDays,
  engagementUrl,
}: Readonly<CompletionRequestEmailProps>) {
  const phrases = milestonePhrases(milestonesTotal);
  return (
    <ReviewEmailLayout
      preview={`${actorExpert} ${phrases.previewLead}. Take a look and make it official — you have until ${autoDate}.`}
      pill="🎉 Project delivered"
      heading="Your project is complete!"
      subtext={`${expertParty} has ${phrases.subtextLead} — the finishing touch is ${clientCompany}'s.`}
    >
      <Text style={styles.greeting}>Hi {firstName},</Text>
      <Text style={styles.bodyText}>
        Great news — {actorExpert} marked <strong>{projectTitle}</strong> complete on{' '}
        {requestedDate}
        {phrases.bodyClause === '' ? '' : `, with ${phrases.bodyClause}`}. Nice work getting this
        over the line together. The last step is yours: take a look and make it official.
      </Text>

      <ProjectSummary
        projectTitle={projectTitle}
        expertParty={expertParty}
        deliveryPlanValue={phrases.planValue}
        requestedDate={requestedDate}
      />

      <Section style={styles.windowBlock}>
        <p style={styles.windowKicker}>The final step</p>
        <p style={styles.windowHeadline}>Take until {autoDate} — no rush</p>
        <p style={styles.windowText}>
          {clientCompany} has {reviewDays} days to look everything over. Accept the project or
          request changes any time before {autoDate} — and if the date slips by, we&apos;ll{' '}
          <strong>close the project out as delivered automatically</strong>, so nothing is ever left
          hanging.
        </p>
      </Section>

      <DualCta engagementUrl={engagementUrl} />

      <Hr style={styles.divider} />
      <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
        Not sure about something in the delivery? Requesting changes sends the project back to{' '}
        {expertParty} with your note — nothing is final until you&apos;re happy or the window
        closes. Questions? Just reply to this email.
      </Text>
    </ReviewEmailLayout>
  );
}
