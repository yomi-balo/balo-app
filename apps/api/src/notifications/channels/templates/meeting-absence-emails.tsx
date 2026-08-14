import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  Callout,
  EmailShell,
  LogoRow,
  StatusPill,
  SupportFooter,
} from './shared.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';

/**
 * BAL-134 (§6) — THE TWO ABSENCE EMAILS, IN ONE FILE.
 *
 * ⚠ ONE FILE, TWO COMPONENTS, ONE SHARED PILL STYLE — deliberately, for the same reason
 * `meeting-guest-emails.tsx` groups its three: two near-identical `EmailShell` scaffolds in
 * separate files is exactly the 10+-identical-lines shape SonarCloud's new-code duplication
 * gate flags, and duplication is scanner-computed so no local gate catches it.
 *
 * ── ⚠ COPY REGISTER (CLAUDE.md) ──────────────────────────────────────────────────────────
 *
 *   · GENDER-NEUTRAL throughout — never a pronoun for an expert or a client.
 *   · PROSPECTIVE copy names the **PARTY**, not a person: the expert's AGENCY (or an
 *     independent expert's own name), never an invented individual. `null` ⇒ neutral wording.
 *   · WARM AND FACTUAL, never adversarial and never countdown-led. The client nudge is a
 *     helpful fact ("your consultation has started — join here"), NOT a billing threat: the
 *     client is not at fault for being a few minutes late, and telling them what a delay costs
 *     is both wrong here (nothing is charged until both sides are present) and hostile.
 *   · NO MONEY FIGURE ANYWHERE. This ticket produces the MEASUREMENT; BAL-412 settles.
 */

const absencePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.16)',
  border: '1px solid rgba(217, 119, 6, 0.35)',
  color: '#FDE68A',
};

export interface MeetingExpertAbsentAdminEmailProps {
  readonly meetingId: string;
  readonly minutesPastStart: number;
  /** The meeting's context type, humanised — e.g. "case". Ops triage context, not PII. */
  readonly contextLabel: string;
  readonly scheduledStartIso: string;
  readonly baseUrl: string;
}

/**
 * TO BALO OPS. The salvage alert — a human has to go and find the expert.
 *
 * ⚠ IT NAMES NOBODY, AND THAT IS DELIBERATE RATHER THAN THIN. Ops opens the meeting to act on
 * it, so a NAME frozen into a scheduled row would be stale by fire time and is PII sitting in a
 * Postgres table for the life of the promise (ADR-1047 Decision 4) in exchange for nothing.
 * The meeting id is the actionable field.
 *
 * ⚠ THE CTA IS AN INTERNAL DEEP LINK. It reaches an authenticated Balo surface; the email
 * itself carries no credential of any kind.
 */
export function MeetingExpertAbsentAdminEmail({
  meetingId,
  minutesPastStart,
  contextLabel,
  scheduledStartIso,
  baseUrl,
}: Readonly<MeetingExpertAbsentAdminEmailProps>) {
  return (
    <EmailShell previewText="An expert has not joined a consultation" baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Needs a human" style={absencePillStyle} />
        <Heading style={shared.smallHeroHeading}>An expert has not joined.</Heading>
        <Text style={shared.smallHeroSubtext}>
          {`No one from the expert side has joined ${minutesPastStart} minutes after the scheduled start.`}
        </Text>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.bodyText}>
          Balo has committed to contacting the expert when this happens, so this one needs a person.
          The client may still be waiting in the room.
        </Text>

        <Callout
          emoji="📋"
          heading="The consultation"
          // ⚠ FORMATTED, NOT THE RAW ISO INSTANT — through `formatMeetingWindowUtc`, the ONE
          // date formatter these templates share. An ops alert is read under time pressure, and
          // `2026-08-14T10:00:00.000Z` is the one line in it a human has to decode. The helper
          // degrades to the empty string on an unparseable instant rather than rendering
          // `Invalid Date`, so the fallback below never prints nonsense either.
          text={`${contextLabel} · scheduled for ${formatMeetingWindowUtc(scheduledStartIso) || 'an unknown time'} · meeting ${meetingId}`}
          bg={colors.bg}
          borderColor={colors.border}
          headingColor={colors.text}
        />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/meetings/${meetingId}`}>
            Open the consultation →
          </Button>
        </Section>

        <SupportFooter prefix="Something look wrong?" />
      </Section>
    </EmailShell>
  );
}

export interface MeetingClientAbsentEmailProps {
  readonly firstName: string;
  /**
   * WHO IS WAITING, as a PARTY — the expert's agency, or an independent expert's own name.
   * ⚠ `undefined` ⇒ party-neutral copy. Never a guess, and never a pronoun.
   */
  readonly waitingPartyName?: string;
  readonly meetingId: string;
  readonly baseUrl: string;
}

/**
 * TO THE CLIENT COMPANY. A warm nudge: your expert is in the room.
 *
 * ⚠⚠ NO BILLING LINE, AND THAT IS A PRODUCT DECISION RATHER THAN AN OMISSION. Nothing is
 * charged until both sides are present, so a "you are being charged" line would be FALSE; and
 * a "you will be charged" line would be a threat aimed at somebody whose only offence is being
 * a few minutes late. The register rule is a quiet fact, not a countdown.
 */
export function MeetingClientAbsentEmail({
  firstName = 'there',
  waitingPartyName,
  meetingId,
  baseUrl,
}: Readonly<MeetingClientAbsentEmailProps>) {
  // ⚠ NO NESTED TERNARY (SonarCloud) — one named value, one branch.
  const waitingLine =
    waitingPartyName === undefined
      ? 'Your expert is in the room and ready when you are.'
      : `${waitingPartyName} is in the room and ready when you are.`;

  return (
    <EmailShell previewText="Your consultation has started" baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Waiting for you" style={absencePillStyle} />
        <Heading style={shared.smallHeroHeading}>Your consultation has started.</Heading>
        <Text style={shared.smallHeroSubtext}>{waitingLine}</Text>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        <Text style={shared.bodyText}>
          Join whenever you are ready — the link below takes you straight in. If something has come
          up, no problem at all; just let them know.
        </Text>

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={`${baseUrl}/meetings/${meetingId}/call`}>
            Join the call →
          </Button>
        </Section>

        <SupportFooter prefix="Trouble joining?" />
      </Section>
    </EmailShell>
  );
}
