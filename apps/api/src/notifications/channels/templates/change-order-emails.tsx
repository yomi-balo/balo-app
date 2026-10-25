import { Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { colors, shared, Callout, SupportFooter } from './shared.js';
import { NoticeShell, ViewProjectCta, successPill, amberPill } from './notice-shell.js';

/**
 * The change-order emails, one component per email, on the platform `EmailShell` primitives.
 *
 *   ChangeOrderRequestedExpertEmail — change_order.requested → expert (act)
 *   ChangeOrderSentClientEmail      — change_order.sent      → client (review)
 *   ChangeOrderApprovedExpertEmail  — change_order.approved  → expert (warm)
 *   ChangeOrderApprovedAdminEmail   — change_order.approved  → admins (no amounts)
 *   ChangeOrderDeclinedExpertEmail  — change_order.declined  → expert (reason verbatim)
 *   ChangeOrderAnsweredClientEmail  — change_order.answered  → client (answer verbatim)
 *
 * Fee concealment: the client email takes the CLIENT price label only and the expert email the
 * EXPERT price label only; the admin email takes no figure at all. Retrospective copy names the
 * person "@ org"; prospective copy names the party.
 */

interface ChangeOrderShellProps {
  readonly previewText: string;
  readonly pillLabel: string;
  readonly pillStyle: CSSProperties;
  readonly heading: string;
  readonly firstName: string;
  readonly engagementUrl: string;
  readonly ctaLabel: string;
  readonly baseUrl: string;
  readonly children: ReactNode;
}

function ChangeOrderShell({
  engagementUrl,
  ctaLabel,
  children,
  ...shell
}: Readonly<ChangeOrderShellProps>) {
  return (
    <NoticeShell {...shell}>
      {children}
      <ViewProjectCta engagementUrl={engagementUrl} label={ctaLabel} />
      <SupportFooter prefix="Questions?" />
    </NoticeShell>
  );
}

function NoteCallout({ heading, text }: Readonly<{ heading: string; text: string }>) {
  return (
    <Callout
      emoji="✏️"
      heading={heading}
      text={text}
      bg={colors.bg}
      borderColor={colors.border}
      headingColor={colors.text}
    />
  );
}

// ── change_order.requested → EXPERT (act) ────────────────────────
export interface ChangeOrderRequestedExpertEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly projectTitle: string;
  readonly note: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function ChangeOrderRequestedExpertEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  projectTitle = 'your project',
  note = '',
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderRequestedExpertEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`${actorClientLabel} asked for a change to ${projectTitle}.`}
      pillLabel="Change requested"
      pillStyle={amberPill}
      heading="A change was requested"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Open the project →"
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorClientLabel} asked for a change to <strong>{projectTitle}</strong>.
      </Text>
      <NoteCallout heading="What they asked for" text={note} />
      <Text style={{ ...shared.bodyText, margin: 0 }}>
        Propose a change if it affects scope or price, or answer it from the project page.
      </Text>
    </ChangeOrderShell>
  );
}

// ── change_order.sent → CLIENT (review) ──────────────────────────
export interface ChangeOrderSentClientEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly projectTitle: string;
  readonly summary: string;
  readonly linesAdded: number;
  readonly linesEdited: number;
  readonly linesRemoved: number;
  /** Pre-formatted CLIENT price change (fixed) or estimate change (T&M); absent ⇒ no line. */
  readonly changeLabel?: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function ChangeOrderSentClientEmail({
  firstName = 'there',
  actorExpertLabel = 'Your expert',
  projectTitle = 'your project',
  summary = '',
  linesAdded = 0,
  linesEdited = 0,
  linesRemoved = 0,
  changeLabel,
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderSentClientEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`${actorExpertLabel} proposed a change to ${projectTitle}. Nothing changes unless you approve it.`}
      pillLabel="Change proposed"
      pillStyle={amberPill}
      heading="A change is waiting for your review"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Review the change →"
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorExpertLabel} proposed a change to <strong>{projectTitle}</strong>.
      </Text>
      <NoteCallout heading="What's changing and why" text={summary} />
      <Text style={shared.bodyText}>
        {linesAdded} added · {linesEdited} edited · {linesRemoved} removed
      </Text>
      {changeLabel ? <Text style={shared.bodyText}>{changeLabel}</Text> : null}
      <Text style={{ ...shared.bodyText, margin: 0 }}>
        Nothing changes unless you approve it. Approved changes are settled on your final invoice.
      </Text>
    </ChangeOrderShell>
  );
}

// ── change_order.approved → EXPERT (warm) ────────────────────────
export interface ChangeOrderApprovedExpertEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly projectTitle: string;
  readonly approvedOn: string;
  /** 'tm' switches the "what was updated" sentence to estimates (and the cap when it moved). */
  readonly pricingMethod?: 'fixed' | 'tm';
  /** T&M only: the cap moved with this change. */
  readonly capMoved?: boolean;
  /** Pre-formatted EXPERT price/cap change and estimate change; absent ⇒ no line. */
  readonly changeLabel?: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

function approvedUpdateSentence(pricingMethod: 'fixed' | 'tm', capMoved: boolean): string {
  if (pricingMethod !== 'tm') {
    return 'The plan and price are updated — the difference is settled at the end of the project.';
  }
  return capMoved
    ? 'The plan, estimates and cap are updated.'
    : 'The plan and estimates are updated.';
}

export function ChangeOrderApprovedExpertEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  projectTitle = 'your project',
  approvedOn,
  pricingMethod = 'fixed',
  capMoved = false,
  changeLabel,
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderApprovedExpertEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`${actorClientLabel} approved your change to ${projectTitle}.`}
      pillLabel="Change approved"
      pillStyle={successPill}
      heading="Your change was approved 🎉"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Open the project →"
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorClientLabel} approved your change to <strong>{projectTitle}</strong> on {approvedOn}.
        {approvedUpdateSentence(pricingMethod, capMoved)}
      </Text>
      {changeLabel ? <Text style={shared.bodyText}>{changeLabel}</Text> : null}
    </ChangeOrderShell>
  );
}

// ── change_order.approved → ADMINS (no amounts) ──────────────────
export interface ChangeOrderApprovedAdminEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly expertParty: string;
  readonly projectTitle: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function ChangeOrderApprovedAdminEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  expertParty = 'the expert',
  projectTitle = 'the project',
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderApprovedAdminEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`Change approved on ${projectTitle}.`}
      pillLabel="Change approved"
      pillStyle={successPill}
      heading="Change approved"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Open the engagement →"
      baseUrl={baseUrl}
    >
      <Text style={{ ...shared.bodyText, margin: 0 }}>
        {actorClientLabel} approved a change from {expertParty} on <strong>{projectTitle}</strong>.
        Figures are on the project page.
      </Text>
    </ChangeOrderShell>
  );
}

// ── change_order.declined → EXPERT (reason verbatim) ─────────────
export interface ChangeOrderDeclinedExpertEmailProps {
  readonly firstName: string;
  readonly actorClientLabel: string;
  readonly projectTitle: string;
  readonly reason: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function ChangeOrderDeclinedExpertEmail({
  firstName = 'there',
  actorClientLabel = 'The client',
  projectTitle = 'your project',
  reason = '',
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderDeclinedExpertEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`${actorClientLabel} declined the change to ${projectTitle}.`}
      pillLabel="Change declined"
      pillStyle={amberPill}
      heading="The change was declined"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Open the project →"
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorClientLabel} declined the change to <strong>{projectTitle}</strong>.
      </Text>
      <NoteCallout heading="Their reason" text={reason} />
      <Text style={{ ...shared.bodyText, margin: 0 }}>
        You can propose a different change from the project page.
      </Text>
    </ChangeOrderShell>
  );
}

// ── change_order.answered → CLIENT (answer verbatim) ─────────────
export interface ChangeOrderAnsweredClientEmailProps {
  readonly firstName: string;
  readonly actorExpertLabel: string;
  readonly projectTitle: string;
  readonly answer: string;
  readonly engagementUrl: string;
  readonly baseUrl: string;
}

export function ChangeOrderAnsweredClientEmail({
  firstName = 'there',
  actorExpertLabel = 'Your expert',
  projectTitle = 'your project',
  answer = '',
  engagementUrl,
  baseUrl,
}: Readonly<ChangeOrderAnsweredClientEmailProps>) {
  return (
    <ChangeOrderShell
      previewText={`${actorExpertLabel} answered your change request on ${projectTitle}.`}
      pillLabel="Request answered"
      pillStyle={successPill}
      heading="Your request was answered"
      firstName={firstName}
      engagementUrl={engagementUrl}
      ctaLabel="Open the project →"
      baseUrl={baseUrl}
    >
      <Text style={shared.bodyText}>
        {actorExpertLabel} answered your change request on <strong>{projectTitle}</strong>.
      </Text>
      <NoteCallout heading="The answer" text={answer} />
      <Text style={{ ...shared.bodyText, margin: 0 }}>Nothing on the project changed.</Text>
    </ChangeOrderShell>
  );
}
