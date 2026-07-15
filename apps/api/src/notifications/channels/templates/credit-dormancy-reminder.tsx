import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/** Which pre-expiry band this reminder addresses (BAL-380). */
export type DormancyReminderWindow = 60 | 30;

/**
 * Props for the dormancy-reminder email (BAL-380). `balance` + `expiryDate` are
 * pre-formatted display strings (the factory formats the raw `balanceMinor` / ISO
 * `expiresAt` via `credit-format`); the recipient's own first name arrives as
 * `firstName` (email adapter `recipientName`, greeted below).
 */
export interface CreditDormancyReminderEmailProps {
  readonly firstName: string;
  readonly window: DormancyReminderWindow;
  readonly balance: string;
  readonly expiryDate: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/** Calm, primary-toned pill (the balance is available — never an alarm). */
const calmPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

/**
 * Dormancy-reminder email (BAL-380 / ADR-1040 Lane 3) — a warm, non-countdown nudge
 * that a client's balance is still there. Rolling expiry means these fire on inactivity,
 * NOT a looming date: the copy leads with "still here" and states the date as a plain
 * fact ("stays available until {date}"), never "expires in N days" / any urgency. Any
 * consultation or top-up resets the clock, so each variant points at the value outcome
 * (find an expert / start a consultation). One layout parameterised by `window` (like
 * `ProjectBillingReminderEmail`'s `role`) so the 60d + 30d variants stay in lockstep;
 * only the copy — and the CTA label — vary. Gender-neutral throughout.
 */
export function CreditDormancyReminderEmail({
  firstName = 'there',
  window,
  balance,
  expiryDate,
  ctaUrl,
  baseUrl,
}: Readonly<CreditDormancyReminderEmailProps>) {
  const copy =
    window === 60
      ? {
          previewText: `Your balance of ${balance} is here whenever you need it — no rush.`,
          heroHeading: 'Your balance is still here',
          heroSubtext: 'It stays available for you — any activity keeps it going.',
          bodyLines: [
            `It's been a little while since your last consultation. Your balance of ${balance} is still here, ready whenever a Salesforce question comes up.`,
            `It stays available until ${expiryDate} — any consultation or top-up keeps it going.`,
          ],
          ctaLabel: 'Find an expert',
        }
      : {
          previewText: `Your Balo balance of ${balance} stays available until ${expiryDate}.`,
          heroHeading: `Your balance stays available until ${expiryDate}`,
          heroSubtext: 'A good time to put it to use — no rush.',
          bodyLines: [
            `Your Balo balance of ${balance} is still here for you.`,
            "If there's a question you've been meaning to run past an expert, now's a nice time — and any consultation or top-up keeps your balance going.",
          ],
          ctaLabel: 'Start a consultation',
        };

  return (
    <EmailShell previewText={copy.previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Your Balo balance" style={calmPillStyle} />
        <Heading style={shared.smallHeroHeading}>{copy.heroHeading}</Heading>
        <Text style={shared.smallHeroSubtext}>{copy.heroSubtext}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        {copy.bodyLines.map((line) => (
          <Text key={line} style={shared.bodyText}>
            {line}
          </Text>
        ))}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            {copy.ctaLabel} →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about your balance?" />
      </Section>
    </EmailShell>
  );
}
