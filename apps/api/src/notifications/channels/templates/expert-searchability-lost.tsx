import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, SupportFooter } from './shared.js';

// ── Styles (structured on calendar-reconnect-required.tsx) ─────────
const styles = {
  hero: {
    ...shared.heroBase,
    padding: '36px 40px 32px',
  },
  heroHeading: {
    ...shared.heroHeadingBase,
    fontSize: '24px',
    margin: '14px 0 10px',
    lineHeight: '1.28',
  } as const,
  heroSubtext: {
    ...shared.heroSubtext,
    fontSize: '15px',
    color: 'rgba(255,255,255,0.70)',
  } as const,
  bodyText: {
    ...shared.bodyText,
    margin: '0 0 20px',
  } as const,
  ctaButton: {
    ...shared.ctaButton,
    fontSize: '15px',
    padding: '13px 32px',
    letterSpacing: '0.01em',
  } as const,
};

/**
 * Join human item labels into a natural "profile, rate and payouts" list. `''` for an empty
 * array (defensive only — `getEmailTemplate` never resolves this template on an empty list,
 * since a genuine transition to `searchable: false` always has ≥1 failing item).
 */
function joinLabels(labels: readonly string[]): string {
  const [firstLabel] = labels;
  if (firstLabel === undefined) return '';
  if (labels.length === 1) return firstLabel;

  const allButLast = labels.slice(0, -1);
  // `noUncheckedIndexedAccess`: destructure + guard, never `!`.
  const [lastLabel] = labels.slice(-1);
  if (lastLabel === undefined) return allButLast.join(', ');
  return `${allButLast.join(', ')} and ${lastLabel}`;
}

// ── Template ─────────────────────────────────────────────────────

interface ExpertSearchabilityLostEmailProps {
  readonly firstName: string;
  readonly failingItemLabels: readonly string[];
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/**
 * BAL-414 (D1/D2) — the NON-calendar de-list (rate / payouts / profile / phone /
 * availability-rules regressing, or the expert's own calendar disconnect). The calendar-CAUSED
 * de-list never reaches this template — it rides the strengthened `calendar-reconnect-required`
 * email instead (one email per underlying cause).
 *
 * Sent to the DELIVERING EXPERT whose checklist regressed. Gender-neutral, warm, and NEVER
 * adversarial (CLAUDE.md copy rules): this states two quiet facts — the search de-list and the
 * public-profile pause — and points at exactly what closes the gap, never a countdown or a
 * threat.
 */
export function ExpertSearchabilityLostEmail({
  firstName = 'there',
  failingItemLabels,
  ctaUrl,
  baseUrl,
}: Readonly<ExpertSearchabilityLostEmailProps>) {
  const previewText = "You've stopped appearing in Balo search — pick up where you left off.";
  const remaining = joinLabels(failingItemLabels);

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow />
        <Heading style={styles.heroHeading}>You&apos;ve stopped appearing in search</Heading>
        <Text style={styles.heroSubtext}>
          Finish the items below and you&apos;ll be back in front of clients.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        <Text style={styles.bodyText}>
          One of the items that keeps you listed on Balo needs attention, so you&apos;ve stopped
          appearing in Balo search and your public profile link is on hold — your account and past
          bookings are untouched.
        </Text>

        {remaining.length > 0 && (
          <Text style={styles.bodyText}>
            What&apos;s left: <strong>{remaining}</strong>.
          </Text>
        )}

        <Text style={styles.bodyText}>
          Finish these and you&apos;re back in search — no rush, and nothing else is affected in the
          meantime.
        </Text>

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '32px 0 28px' }}>
          <Button style={styles.ctaButton} href={ctaUrl}>
            Finish your setup →
          </Button>
        </Section>

        <SupportFooter prefix="Need a hand?" />
      </Section>
    </EmailShell>
  );
}
