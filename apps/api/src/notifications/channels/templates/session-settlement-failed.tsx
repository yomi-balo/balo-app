import { Button, Heading, Link, Section, Text } from '@react-email/components';
import { colors, shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * Props for the balance dunning email (BAL-474 / ADR-1040 Amendment 7 §G). ONE shape for the
 * whole wallet — the notice is neutral about how many consultations ran over and states the TOTAL
 * top-up that clears the hold. `amount` and `asOf` arrive pre-formatted (`A$275.00`,
 * `2:05 pm UTC, 23 September 2026`); the factory in `./index.ts` computes the three flags.
 *
 * - `exceedsSingleTopUp` → the figure is above `maxTopUp`, the top-up page's per-top-up limit, so
 *   the copy says "top-ups totalling …" and names that limit.
 * - `promoWasGranted` → one sentence: promo credit does not count towards clearing the hold.
 * - `confirmationWasRequested` → one RETROSPECTIVE sentence and a secondary link to the card
 *   settings. It states a past fact about an earlier attempt, so it stays true after a card swap.
 *
 * `companyLabel` is the company's name, or "your team" when it did not resolve.
 */
export interface SessionSettlementFailedEmailProps {
  readonly firstName: string;
  readonly companyLabel: string;
  readonly amount: string;
  readonly asOf: string;
  readonly exceedsSingleTopUp: boolean;
  readonly maxTopUp: string;
  readonly promoWasGranted: boolean;
  readonly confirmationWasRequested: boolean;
  readonly ctaUrl: string;
  readonly cardSettingsUrl: string;
  readonly baseUrl: string;
}

/** Amber attention pill (needs a small action, but not an alarm). */
const attentionPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(245, 158, 11, 0.18)',
  border: '1px solid rgba(245, 158, 11, 0.35)',
  color: '#FDE68A',
};

const PROMO_SENTENCE =
  "Anything beyond what's owed stays in your balance to use on consultations. Promo credit doesn't count towards clearing it, which is why this figure can be higher than what's owed.";

const CONFIRMATION_SENTENCE =
  "One earlier payment needed an extra card confirmation when it was attempted — it's worth a quick look at the card in billing settings.";

/** The preheader, dated, in the singular or the "top-ups totalling" wording. */
function previewTextFor(props: Readonly<SessionSettlementFailedEmailProps>): string {
  return props.exceedsSingleTopUp
    ? `As of ${props.asOf}, top-ups totalling ${props.amount} or more clear it.`
    : `As of ${props.asOf}, a top-up of ${props.amount} or more clears it.`;
}

/** Body line 1 — the total top-up and what it gates. Names no session and no count. */
function leadLineFor(props: Readonly<SessionSettlementFailedEmailProps>): string {
  const needs = props.exceedsSingleTopUp
    ? `needs top-ups totalling ${props.amount} or more to clear — each top-up can be up to ${props.maxTopUp}.`
    : `needs a top-up of ${props.amount} or more to clear.`;
  return `As of ${props.asOf}, ${props.companyLabel}'s balance ${needs} Until it's clear, new consultations can't be booked.`;
}

/**
 * Balance dunning email (BAL-474 / ADR-1040 Amendment 7 §G, owner ruling D6.2) — a warm nudge to
 * the billing admins that the company's balance needs a top-up before new consultations can be
 * booked. The figure is a TOP-UP amount, dated "as of" the instant it was read, never a debt: it
 * can exceed what the balance widget shows because promo credit does not count towards clearing.
 *
 * ⚠ THE CTA IS ALWAYS "Top up". A covering cash top-up is the only thing that clears the hold —
 * dunning never re-charges the card and nothing completes a card confirmation on a settlement
 * charge (Amendment 6 §G.3) — so a card-confirmation call to action would promise a remedy that
 * does not exist. The card link is secondary and only appears with the retrospective sentence.
 *
 * ⚠ NO PROMISED OUTCOME, NO "extra time", NO "nothing else to do". It states a condition
 * ("before new consultations can be booked") and never claims a top-up guarantees a booking.
 * Gender-neutral; no rate, fee or margin.
 */
export function SessionSettlementFailedEmail(props: Readonly<SessionSettlementFailedEmailProps>) {
  const { firstName = 'there', ctaUrl, cardSettingsUrl, baseUrl } = props;

  return (
    <EmailShell previewText={previewTextFor(props)} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 A quick heads-up" style={attentionPillStyle} />
        <Heading style={shared.smallHeroHeading}>Let&apos;s settle the balance</Heading>
        <Text style={shared.smallHeroSubtext}>
          Consultations already booked aren&apos;t affected.
        </Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{leadLineFor(props)}</Text>
        {props.promoWasGranted && <Text style={shared.bodyText}>{PROMO_SENTENCE}</Text>}
        {props.confirmationWasRequested && (
          <Text style={shared.bodyText}>{CONFIRMATION_SENTENCE}</Text>
        )}

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Top up →
          </Button>
        </Section>

        {props.confirmationWasRequested && (
          <Text style={{ ...shared.bodyText, fontSize: '13px', textAlign: 'center' }}>
            <Link href={cardSettingsUrl} style={{ color: colors.primary }}>
              Check the card in billing settings
            </Link>
          </Text>
        )}

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
