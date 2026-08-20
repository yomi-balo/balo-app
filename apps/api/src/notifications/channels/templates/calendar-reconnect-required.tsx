import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, SupportFooter } from './shared.js';

// ── Reconnect-required styles (structured on onboarding-reminder.tsx) ──────
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

// ── Template ─────────────────────────────────────────────────────

interface CalendarReconnectRequiredEmailProps {
  readonly firstName: string;
  readonly providerLabel: string;
  readonly ctaUrl: string;
  readonly baseUrl: string;
  /**
   * BAL-414 (D10, addendum) — the SAME derived value `flipToReconnectRequired` used to decide
   * the DB de-list, passed straight through the payload — never recomputed here. Under D4
   * (ANY-ACTIVE) an expert with a second healthy connected calendar stays fully searchable
   * even while THIS one is broken, so the two arms below say materially different things
   * rather than one unconditional (and sometimes false) search-pause claim.
   */
  readonly stillSearchable: boolean;
}

/**
 * BAL-396 §7 (Objection 5) — the reconnect email `calendar.auth_error` already fired but had
 * no template (no rule either — see `engine/rules.ts`). Sent to the DELIVERING EXPERT whose
 * Apiroc credential broke, at most once per breakage (`credential-status.ts` owns the
 * notify-once suppression; the engine itself provides none).
 *
 * Gender-neutral, warm, and NEVER adversarial (CLAUDE.md copy rules): this is a quiet fact —
 * "your availability is paused" — not a countdown or a threat. Second person is correct here
 * (prospective copy would normally name the PARTY, but the party IS the recipient).
 */
export function CalendarReconnectRequiredEmail({
  firstName = 'there',
  providerLabel,
  ctaUrl,
  baseUrl,
  stillSearchable,
}: Readonly<CalendarReconnectRequiredEmailProps>) {
  const previewText = stillSearchable
    ? 'Your calendar disconnected — reconnect so your busy time is covered again.'
    : 'Your calendar disconnected — reconnect to appear in search again.';

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={styles.hero}>
        <LogoRow />
        <Heading style={styles.heroHeading}>Your calendar disconnected</Heading>
        <Text style={styles.heroSubtext}>
          {stillSearchable
            ? "Your profile, rate and past bookings are all safe, and you're still appearing in Balo search."
            : 'Your profile, rate and past bookings are all safe — reconnecting brings everything straight back.'}
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>

        {stillSearchable ? (
          <Text style={styles.bodyText}>
            Balo lost access to your {providerLabel}, so busy time on it is no longer being checked
            before a booking — you could end up double-booked against it. Your other connected
            calendar is still covering your Balo search listing, and your profile, rate and past
            bookings are untouched. Reconnecting brings your full availability picture back.
          </Text>
        ) : (
          <Text style={styles.bodyText}>
            Balo lost access to your {providerLabel}, so your availability is paused. While
            it&apos;s paused you won&apos;t appear in Balo search and your public profile link is on
            hold too. Your profile, rate and past bookings are untouched — reconnecting brings it
            all straight back.
          </Text>
        )}

        <Text style={styles.bodyText}>
          If you turned Balo&apos;s access off at your calendar provider, you may need to remove it
          there first before reconnecting — the consent screen won&apos;t ask again otherwise.
        </Text>

        {/* CTA */}
        <Section style={{ ...shared.ctaWrapper, margin: '32px 0 28px' }}>
          <Button style={styles.ctaButton} href={ctaUrl}>
            Reconnect calendar →
          </Button>
        </Section>

        <SupportFooter prefix="Need a hand reconnecting?" />
      </Section>
    </EmailShell>
  );
}
