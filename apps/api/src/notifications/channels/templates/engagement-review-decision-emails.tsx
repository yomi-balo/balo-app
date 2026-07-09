import { Button, Heading, Section, Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';
import { milestonePhrases } from './review-email-shared.js';

/**
 * BAL-338 (D7) — the EXPERT- and ADMIN-facing project-review-decision emails, built
 * on the platform `EmailShell` primitives (like `engagement-cancelled.tsx`) with the
 * ticket's drafted copy. The CLIENT-facing variants (ReviewReminderEmail /
 * AutoAcceptedEmail) live in the bespoke review-email family instead.
 *
 * Emails here:
 *   EngagementAcceptedExpertEmail      — engagement.accepted     → expert (congrats)
 *   EngagementAutoAcceptedExpertEmail  — engagement.auto_accepted → expert (congrats)
 *   EngagementChangesRequestedExpertEmail — engagement.changes_requested → expert (act)
 *   EngagementReadyToInvoiceEmail      — accepted | auto_accepted → admins (money)
 *
 * COPY CONVENTIONS (BAL-329): retrospective copy names the PERSON "@ company" on first
 * mention (`actorClientLabel`); prospective copy names the PARTY (`clientCompany`).
 * Dates are pre-formatted UTC strings. The admin "Ready to invoice: final installment"
 * subject format is kept STABLE across the client-accept and auto-accept paths (it is
 * the money trigger).
 */

const successPill: CSSProperties = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.16)',
  border: '1px solid rgba(5, 150, 105, 0.32)',
  color: '#6EE7B7',
};

const amberPill: CSSProperties = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.16)',
  border: '1px solid rgba(217, 119, 6, 0.32)',
  color: '#FCD34D',
};

interface NoticeShellProps {
  readonly previewText: string;
  readonly pillLabel: string;
  readonly pillStyle: CSSProperties;
  readonly heading: string;
  readonly subtext?: string;
  readonly firstName: string;
  readonly baseUrl: string;
  readonly children: ReactNode;
}

/** Shared shell for the D7 decision emails: hero (logo/pill/heading) + card (greeting + body). */
function NoticeShell({
  previewText,
  pillLabel,
  pillStyle,
  heading,
  subtext,
  firstName,
  baseUrl,
  children,
}: NoticeShellProps) {
  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={pillLabel} style={pillStyle} />
        <Heading style={shared.smallHeroHeading}>{heading}</Heading>
        {subtext ? <Text style={shared.smallHeroSubtext}>{subtext}</Text> : null}
      </Section>
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        {children}
      </Section>
    </EmailShell>
  );
}

/** A "View the project →" CTA linking to the delivery workspace. */
function ViewProjectCta({
  engagementUrl,
  label = 'View the project →',
}: Readonly<{
  engagementUrl: string;
  label?: string;
}>) {
  return (
    <Section style={{ ...shared.ctaWrapper, margin: '24px 0 4px' }}>
      <Button style={shared.smallCtaButton} href={engagementUrl}>
        {label}
      </Button>
    </Section>
  );
}

// ── engagement.accepted → EXPERT (congratulations) ───────────────
export interface EngagementAcceptedExpertEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly projectTitle: string;
  readonly acceptedOn: string;
  readonly milestonesTotal: number;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function EngagementAcceptedExpertEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  projectTitle = 'your project',
  acceptedOn,
  milestonesTotal = 0,
  engagementUrl,
  baseUrl,
}: Readonly<EngagementAcceptedExpertEmailProps>) {
  const done = milestonePhrases(milestonesTotal).doneClause;
  return (
    <NoticeShell
      previewText={`${actorClientLabel} accepted ${projectTitle} — congratulations on the delivery.`}
      pillLabel="Project accepted"
      pillStyle={successPill}
      heading="Your project was accepted 🎉"
      firstName={firstName}
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorClientLabel} accepted the project on {acceptedOn} — congratulations on the delivery.
        {done === '' ? '' : ` ${done}.`} Balo takes care of the final invoice; nothing more needed
        from you.
      </Text>
      <ViewProjectCta engagementUrl={engagementUrl} />
      <SupportFooter prefix="Questions?" />
    </NoticeShell>
  );
}

// ── engagement.auto_accepted → EXPERT (congratulations) ──────────
export interface EngagementAutoAcceptedExpertEmailProps {
  readonly firstName: string;
  readonly clientCompany: string;
  readonly projectTitle: string;
  readonly autoDate: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function EngagementAutoAcceptedExpertEmail({
  firstName = 'there',
  clientCompany = 'The client',
  projectTitle = 'your project',
  autoDate,
  engagementUrl,
  baseUrl,
}: Readonly<EngagementAutoAcceptedExpertEmailProps>) {
  return (
    <NoticeShell
      previewText={`${projectTitle} is complete — it closed out as delivered after the review window.`}
      pillLabel="Project complete"
      pillStyle={successPill}
      heading="Project complete 🎉"
      firstName={firstName}
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {clientCompany}&apos;s review window wrapped up on {autoDate}, so the project closed out as
        delivered — congratulations. Balo takes care of the final invoice.
      </Text>
      <ViewProjectCta engagementUrl={engagementUrl} />
      <SupportFooter prefix="Questions?" />
    </NoticeShell>
  );
}

// ── engagement.changes_requested → EXPERT (act) ──────────────────
export interface EngagementChangesRequestedExpertEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly projectTitle: string;
  readonly note: string;
  readonly reviewDays: number;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function EngagementChangesRequestedExpertEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  projectTitle = 'your project',
  note = '',
  reviewDays = 7,
  engagementUrl,
  baseUrl,
}: Readonly<EngagementChangesRequestedExpertEmailProps>) {
  return (
    <NoticeShell
      previewText={`${actorClientLabel} requested changes on ${projectTitle} before accepting.`}
      pillLabel="Changes requested"
      pillStyle={amberPill}
      heading="Changes requested"
      firstName={firstName}
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorClientLabel} requested changes on <strong>{projectTitle}</strong> before accepting —
        here&apos;s what they&apos;d like addressed.
      </Text>
      <Callout
        emoji="✏️"
        heading="What needs to change"
        text={note}
        bg={colors.bg}
        borderColor={colors.border}
        headingColor={colors.text}
      />
      <Text style={{ ...shared.bodyText, margin: 0 }}>
        The project is active again — mark it complete when it&apos;s fixed; the {reviewDays}-day
        review window restarts then.
      </Text>
      <ViewProjectCta engagementUrl={engagementUrl} label="View what needs to change →" />
      <SupportFooter prefix="Questions?" />
    </NoticeShell>
  );
}

// ── accepted | auto_accepted → ADMINS (the money trigger) ────────
export interface EngagementReadyToInvoiceEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  /** Pre-composed detail line (client-accept vs auto path) — the factory owns the wording. */
  readonly detailLine: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function EngagementReadyToInvoiceEmail({
  firstName = 'there',
  projectTitle = 'the project',
  detailLine,
  engagementUrl,
  baseUrl,
}: Readonly<EngagementReadyToInvoiceEmailProps>) {
  return (
    <NoticeShell
      previewText={`Ready to invoice: final installment — ${projectTitle}.`}
      pillLabel="Ready to invoice"
      pillStyle={amberPill}
      heading="Ready to invoice: final installment"
      firstName={firstName}
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>{detailLine}</Text>
      <ViewProjectCta engagementUrl={engagementUrl} label="Open the engagement →" />
      <SupportFooter prefix="Questions?" />
    </NoticeShell>
  );
}
