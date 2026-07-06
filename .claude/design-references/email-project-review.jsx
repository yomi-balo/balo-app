/**
 * DESIGN REFERENCE — email-project-review.jsx
 * BAL-334 / BAL-338 · Project completion review email family (sent to the CLIENT)
 *
 * Implementation notes for CC:
 * - This IS the implementation template. Copy to apps/api/src/notifications/templates/
 *   (split into three files or keep the shared layout — CC's call, note in PR).
 * - Uses @react-email/components — installed since BAL-175. Rendered via Brevo adapter.
 * - THREE variants share one layout:
 *     CompletionRequestEmail — event: engagement.completion_requested (BAL-334)
 *     ReviewReminderEmail    — event: engagement.review_reminder, T−2 days (BAL-338)
 *     AutoAcceptedEmail      — event: engagement.accepted, acceptance_method='auto' (BAL-338)
 * - COPY CONVENTIONS (BAL-329, binding): gender-neutral; prospective copy names the
 *   PARTY (clientCompany / expertParty — agency name for agency-based experts,
 *   individual's own name for independents); retrospective copy names the PERSON with
 *   "@ company/agency" on first mention (actorExpert). Defaults below demonstrate the
 *   agency case; independent case: expertParty='Priya Sharma', actorExpert='Priya Sharma'.
 * - TONE: warm and congratulatory — completion is the happiest email a client gets.
 *   Celebrate first; state the review window as a helpful fact, never a countdown
 *   threat. The auto-accept date and consequence must still be impossible to miss
 *   (the window block), but framed as "we close it out as delivered so nothing
 *   stalls", not as a deadline.
 * - Props are per-variant; all dates are pre-formatted strings (no date logic here).
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

// ── Design Tokens (same set as email-application-submitted) ──────
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
  // Project summary box
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
  // THE review-window block — the signature element of this family.
  // Amber while a decision is open; success-green for the auto-accepted variant.
  windowBlock: (tone) => ({
    padding: '18px 20px',
    borderRadius: '12px',
    background: tone === 'success' ? c.successLight : c.warningLight,
    border: `1.5px solid ${tone === 'success' ? c.successBorder : c.warningBorder}`,
    margin: '24px 0',
    textAlign: 'center',
  }),
  windowKicker: (tone) => ({
    fontSize: '11px',
    fontWeight: '700',
    color: tone === 'success' ? c.success : c.warning,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    margin: '0 0 6px',
  }),
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
  // Dual CTA
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

// ── Shared layout ────────────────────────────────────────────────
function ReviewEmailLayout({ preview, pill, heading, subtext, children }) {
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

function ProjectSummary({ projectTitle, expertParty, milestonesTotal, requestedDate }) {
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
          All {milestonesTotal} milestones delivered · marked complete {requestedDate}
        </p>
      </div>
    </Section>
  );
}

function DualCta({ engagementUrl }) {
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

// ══════════════════════════════════════════════════════════════════
// VARIANT 1 — Completion request (engagement.completion_requested)
// Subject: "Great news — {projectTitle} is complete 🎉"
// ══════════════════════════════════════════════════════════════════
export function CompletionRequestEmail({
  firstName = 'Dana',
  clientCompany = 'Northwind Industrial',
  expertParty = 'CloudPeak Consulting', // independent case: 'Priya Sharma'
  actorExpert = 'Priya @ CloudPeak', // independent case: 'Priya Sharma'
  projectTitle = 'CPQ implementation to replace legacy quoting tool',
  milestonesTotal = 4,
  requestedDate = '4 Jul',
  autoDate = '11 Jul',
  reviewDays = 7,
  engagementUrl = 'https://balo.expert/engagements/eng_123',
}) {
  return (
    <ReviewEmailLayout
      preview={`${actorExpert} delivered all ${milestonesTotal} milestones. Take a look and make it official — you have until ${autoDate}.`}
      pill="🎉 Project delivered"
      heading="Your project is complete!"
      subtext={`${expertParty} has delivered every milestone — the finishing touch is ${clientCompany}'s.`}
    >
      <Text style={styles.greeting}>Hi {firstName},</Text>
      <Text style={styles.bodyText}>
        Great news — {actorExpert} marked <strong>{projectTitle}</strong> complete on{' '}
        {requestedDate}, with all {milestonesTotal} milestones delivered. Nice work getting this
        over the line together. The last step is yours: take a look and make it official.
      </Text>

      <ProjectSummary
        projectTitle={projectTitle}
        expertParty={expertParty}
        milestonesTotal={milestonesTotal}
        requestedDate={requestedDate}
      />

      {/* The signature block — celebratory framing, but the auto-accept
          date and consequence stay unmissable (BAL-329 transparency). */}
      <Section style={styles.windowBlock('warning')}>
        <p style={styles.windowKicker('warning')}>The final step</p>
        <p style={styles.windowHeadline}>Take until {autoDate} — no rush</p>
        <p style={styles.windowText}>
          {clientCompany} has {reviewDays} days to look everything over. Accept the project or
          request changes any time before {autoDate} — and if the date slips by, we'll{' '}
          <strong>close the project out as delivered automatically</strong>, so nothing is ever left
          hanging.
        </p>
      </Section>

      <DualCta engagementUrl={engagementUrl} />

      <Hr style={styles.divider} />
      <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
        Not sure about something in the delivery? Requesting changes sends the project back to{' '}
        {expertParty} with your note — nothing is final until you're happy or the window closes.
        Questions? Just reply to this email.
      </Text>
    </ReviewEmailLayout>
  );
}

// ══════════════════════════════════════════════════════════════════
// VARIANT 2 — Review reminder, T−2 days (engagement.review_reminder)
// Subject: "Your completed project is waiting — {projectTitle}"
// ══════════════════════════════════════════════════════════════════
export function ReviewReminderEmail({
  firstName = 'Dana',
  clientCompany = 'Northwind Industrial',
  expertParty = 'CloudPeak Consulting',
  projectTitle = 'CPQ implementation to replace legacy quoting tool',
  milestonesTotal = 4,
  requestedDate = '4 Jul',
  autoDate = '11 Jul',
  daysLeft = 2,
  engagementUrl = 'https://balo.expert/engagements/eng_123',
}) {
  return (
    <ReviewEmailLayout
      preview={`A friendly nudge: ${projectTitle} is delivered and waiting for your look. It wraps up as delivered on ${autoDate}.`}
      pill="👋 Friendly nudge"
      heading="Your completed project is waiting"
      subtext={`${projectTitle} wraps up on ${autoDate} — a couple of minutes now makes it official.`}
    >
      <Text style={styles.greeting}>Hi {firstName},</Text>
      <Text style={styles.bodyText}>
        Just a friendly nudge — {expertParty} delivered <strong>{projectTitle}</strong> on{' '}
        {requestedDate}, and it's been waiting for {clientCompany}'s look since. All{' '}
        {milestonesTotal} milestones are done; the finish line is a click away.
      </Text>

      <Section style={styles.windowBlock('warning')}>
        <p style={styles.windowKicker('warning')}>Wrapping up soon</p>
        <p style={styles.windowHeadline}>
          {daysLeft} days to go — wraps up {autoDate}
        </p>
        <p style={styles.windowText}>
          Accept the project or request changes whenever suits before then. If the date passes,
          we'll <strong>close it out as delivered automatically</strong> so nothing stalls — the
          review takes just a couple of minutes.
        </p>
      </Section>

      <DualCta engagementUrl={engagementUrl} />

      <Hr style={styles.divider} />
      <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
        We keep nudges to just this one. Questions? Just reply to this email.
      </Text>
    </ReviewEmailLayout>
  );
}

// ══════════════════════════════════════════════════════════════════
// VARIANT 3 — Auto-accepted (engagement.accepted, method='auto')
// Subject: "{projectTitle} is complete 🎉"
// ══════════════════════════════════════════════════════════════════
export function AutoAcceptedEmail({
  firstName = 'Dana',
  clientCompany = 'Northwind Industrial',
  expertParty = 'CloudPeak Consulting',
  projectTitle = 'CPQ implementation to replace legacy quoting tool',
  milestonesTotal = 4,
  requestedDate = '4 Jul',
  autoDate = '11 Jul',
  reviewDays = 7,
  engagementUrl = 'https://balo.expert/engagements/eng_123',
}) {
  return (
    <ReviewEmailLayout
      preview={`${projectTitle} is complete — wrapped up as delivered on ${autoDate} after the review window.`}
      pill="🎉 Project complete"
      heading={`${projectTitle.length > 42 ? 'Your project' : projectTitle} is complete`}
      subtext={`Wrapped up as delivered after ${clientCompany}'s ${reviewDays}-day review window.`}
    >
      <Text style={styles.greeting}>Hi {firstName},</Text>
      <Text style={styles.bodyText}>
        Congratulations — <strong>{projectTitle}</strong> is complete! {clientCompany}'s review
        window wrapped up on {autoDate}, so we closed the project out as delivered, just as flagged
        when {expertParty} sent it over on {requestedDate}. All {milestonesTotal} milestones were
        delivered along the way.
      </Text>

      <Section style={styles.windowBlock('success')}>
        <p style={styles.windowKicker('success')}>What happens now</p>
        <p style={styles.windowHeadline}>All wrapped up</p>
        <p style={styles.windowText}>
          Balo will be in touch about the final invoice. The delivery plan and every delivery note
          stay right where they are in your workspace, whenever you want them.
        </p>
      </Section>

      <Section style={styles.ctaWrapper}>
        <Button style={styles.ctaPrimary} href={engagementUrl}>
          View the project →
        </Button>
      </Section>

      <Hr style={styles.divider} />
      <Text style={{ ...styles.bodyText, fontSize: '13px', margin: 0 }}>
        Something not quite right with the delivery? Just reply to this email and the Balo team will
        help — closing the project doesn't close the conversation.
      </Text>
    </ReviewEmailLayout>
  );
}

export default CompletionRequestEmail;
