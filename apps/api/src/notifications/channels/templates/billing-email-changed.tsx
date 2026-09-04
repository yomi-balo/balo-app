import { Button, Heading, Section, Text } from '@react-email/components';
import { shared, EmailShell, LogoRow, StatusPill, SupportFooter } from './shared.js';

/**
 * BAL-522 — the TWO emails for `billing.email_changed`, in ONE file (the
 * `credit-saved-card-detached.tsx` / `meeting-guest-emails.tsx` precedent — co-located because
 * they share an audience-adjacent event and would otherwise duplicate the pill/greeting shell).
 *
 * `BillingEmailChangedEmail` — the `company_billing_admins` fan-out (includes the actor, as
 * confirmation). `BillingEmailChangedPreviousEmail` — the PREVIOUS address, notified that it is
 * no longer the billing contact. Both consume `buildBillingEmailChangedCopy`, the ONE shared
 * derivation the in-app factory also calls, so email and in-app copy can never drift.
 *
 * ⚠ THE PREVIOUS-ADDRESS EMAIL NEVER PRINTS THE NEW ADDRESS — that address may now be external
 * to this recipient (they may no longer hold `MANAGE_BILLING`, or may never have been a Balo
 * user at all), so naming it would leak the team's current billing contact to whoever used to
 * hold it. It also carries NO CTA: the recipient may no longer have access to
 * `/settings/billing`, and a dead-end button is worse than none (the `meeting-guest-removed`
 * "no CTA link" precedent for a possibly-non-user recipient).
 */

export interface BillingEmailChangedCopy {
  companyName: string;
  bareName: string;
  label: string;
  newEmail: string;
  previousEmail: string | null;
}

/**
 * BAL-522 (mirrors `buildSavedCardDetachedCopy`, F3) — the copy derivation SHARED by the
 * `billing-email-changed` email + in-app factories AND the `billing-email-changed-previous`
 * email factory. Extracted here so all three consumers stay in lockstep.
 */
export function buildBillingEmailChangedCopy(
  data: Record<string, unknown>
): BillingEmailChangedCopy {
  const company = data.company as { name?: string } | undefined;
  const companyName = company?.name ?? 'your team';
  const bareName = (data.changedByName as string) ?? 'A teammate';
  const label = (data.changedByLabel as string) ?? bareName;
  const newEmail = (data.newEmail as string) ?? '';
  const previousEmail = typeof data.previousEmail === 'string' ? data.previousEmail : null;
  return { companyName, bareName, label, newEmail, previousEmail };
}

const infoPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

export interface BillingEmailChangedEmailProps {
  readonly firstName: string;
  readonly label: string;
  readonly companyName: string;
  readonly newEmail: string;
  /** `null` on a first-ever explicit set — no "it replaces …" clause. */
  readonly previousEmail: string | null;
  readonly ctaUrl: string;
  readonly baseUrl: string;
}

/**
 * The `company_billing_admins` fan-out — a teammate changed the team's billing email. Warm,
 * factual, gender-neutral. Includes the acting holder (self-confirmation).
 */
export function BillingEmailChangedEmail({
  firstName = 'there',
  label,
  companyName,
  newEmail,
  previousEmail,
  ctaUrl,
  baseUrl,
}: Readonly<BillingEmailChangedEmailProps>) {
  const leadSentence = `${label} set ${companyName}'s billing email to ${newEmail}.`;
  const previewText = leadSentence;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Billing update" style={infoPillStyle} />
        <Heading style={shared.smallHeroHeading}>Billing email updated</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>{leadSentence}</Text>
        {previousEmail !== null && (
          <Text style={shared.bodyText}>It replaces {previousEmail}.</Text>
        )}
        <Text style={shared.bodyText}>
          Balo still sends your receipts itself — Stripe uses this address for its own records
          (disputes, support lookup).
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={ctaUrl}>
            Manage billing settings →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about billing?" />
      </Section>
    </EmailShell>
  );
}

export interface BillingEmailChangedPreviousEmailProps {
  readonly label: string;
  readonly companyName: string;
  readonly baseUrl: string;
}

/**
 * The PREVIOUS address — told it is no longer the billing contact. Never prints the new
 * address; no CTA (see the file docblock).
 */
export function BillingEmailChangedPreviousEmail({
  label,
  companyName,
  baseUrl,
}: Readonly<BillingEmailChangedPreviousEmailProps>) {
  const previewText = `Your address is no longer ${companyName}'s billing contact.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="💳 Billing update" style={infoPillStyle} />
        <Heading style={shared.smallHeroHeading}>Your billing contact changed</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.bodyText}>
          {label} updated {companyName}&apos;s billing email on Balo. This address is no longer{' '}
          {companyName}&apos;s billing contact.
        </Text>
        <Text style={shared.bodyText}>
          If this doesn&apos;t look right, reach out to {companyName}&apos;s billing admin.
        </Text>

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
