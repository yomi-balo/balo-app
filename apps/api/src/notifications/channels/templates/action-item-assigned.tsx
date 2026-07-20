import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
} from './shared.js';

/**
 * BAL-391 (ADR-1043) — an action item was assigned to a SIDE of the engagement; the
 * assigned side (the client company owner OR the delivering expert) is notified. ONE
 * component serves both rules — the greeting differs via the per-recipient `firstName`.
 * Bespoke on `EmailShell` (like `engagement-scope-changed`, NOT `ProjectStatusEmail`
 * whose CTA is hardwired to `/projects/{id}`): this email's CTA deep-links to the
 * delivery workspace `/engagements/{id}`. Copy is gender-neutral; `actorLabel` is the
 * retrospective person who assigned it; the due date (when set) reads as a helpful fact,
 * never a countdown. `actionItemBody` is PLAIN TEXT — capped for a tidy email body.
 */
export interface ActionItemAssignedEmailProps {
  readonly firstName: string;
  readonly projectTitle: string;
  readonly actorLabel: string;
  readonly actionItemBody: string;
  readonly dueOn?: string;
  readonly engagementId: string;
  readonly baseUrl: string;
}

const actionItemPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.18)',
  border: '1px solid rgba(37, 99, 235, 0.35)',
  color: '#BFDBFE',
};

const BODY_MAX_LENGTH = 280;

/** Cap the plain-text item body for a tidy email; append an ellipsis when truncated. */
function capBody(body: string): string {
  return body.length > BODY_MAX_LENGTH ? `${body.slice(0, BODY_MAX_LENGTH)}…` : body;
}

export function ActionItemAssignedEmail({
  firstName = 'there',
  projectTitle = 'your project',
  actorLabel = 'A teammate',
  actionItemBody = 'an action item',
  dueOn,
  engagementId,
  baseUrl,
}: Readonly<ActionItemAssignedEmailProps>) {
  const dueLine = dueOn ? ` It's noted for ${dueOn} — no rush.` : '';
  return (
    <EmailShell previewText={`${actorLabel} assigned you an action item`} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Action item assigned" style={actionItemPillStyle} />
        <Heading style={shared.smallHeroHeading}>You have a new action item.</Heading>
        <Text style={shared.smallHeroSubtext}>{projectTitle}</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          {`${actorLabel} assigned you an action item on ${projectTitle}.${dueLine}`}
        </Text>

        <Callout
          emoji="✅"
          heading="Action item"
          text={capBody(actionItemBody)}
          bg={colors.bg}
          borderColor={colors.border}
          headingColor={colors.text}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/engagements/${engagementId}`}>
            View the project →
          </Button>
        </Section>

        <SupportFooter prefix="Questions about this?" />
      </Section>
    </EmailShell>
  );
}
