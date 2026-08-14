import { Button, Heading, Section, Text } from '@react-email/components';
import { personWithOrgLabel } from '@balo/shared/parties';
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
 * BAL-408 / ADR-1044 (+ BAL-436) — the THREE GUEST-FACING emails, in ONE file.
 *
 * ⚠ CO-LOCATED DELIBERATELY (the `case-billing-emails.tsx` / `engagement-accepted-emails.tsx`
 * precedent). They share an audience (a non-Balo-user external person), a greeting, a pill
 * style and the whole meeting-window block; as separate files they were ~40 duplicated lines
 * each and would trip SonarCloud's >3% new-code duplication gate. The shared parts are
 * extracted below and used by all three.
 *
 * ⚠⚠ NEITHER EMAIL CARRIES A BILLING LINE — NO RATE, NO DURATION PRICE, NO BALANCE, NO
 * CURRENCY, EVER. "Billing unaffected — per-minute of expert time, never per-seat" is an
 * acceptance criterion, and this is the surface where a stray figure would leak it to an
 * outsider who is not the payer. If you add a field to either template, check it against
 * that sentence first.
 *
 * ⚠ COUNTERPARTY CONCEALMENT: names cross the party boundary, EMAIL ADDRESSES NEVER. Neither
 * template receives, renders or links any address other than the recipient's own (which is
 * the envelope, not the body).
 *
 * ⚠ THE MAGIC-LINK CTA IS THE ONLY LINK IN THE INVITE, and the raw token NEVER appears as
 * copyable text — the `proposal-shared` rule verbatim.
 *
 * ⚠⚠ AND THAT IS WHY BOTH TEMPLATES TAKE A SEPARATE `baseUrl`, RATHER THAN HANDING THE JOIN
 * URL TO `EmailShell`. `EmailShell` builds its footer as `${baseUrl}/legal/privacy` and
 * `${baseUrl}/legal/terms`. Passing `joinUrl` as the shell's base therefore produced
 * `…/join/{RAW_TOKEN}/legal/privacy` — two DEAD links, and two EXTRA copies of the
 * credential in a message that is forwarded more often than any other on the platform
 * (its whole audience is people outside both parties). `baseUrl` is the site origin;
 * `joinUrl` is the CTA and appears exactly once. Pinned by
 * `meeting-guest-emails.test.ts`'s href sweep.
 */

const guestPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.16)',
  border: '1px solid rgba(37, 99, 235, 0.34)',
  color: '#93C5FD',
};

const whenBlockStyle = {
  margin: '20px 0',
  padding: '16px 18px',
  borderRadius: '10px',
  background: colors.bg,
  border: `1px solid ${colors.border}`,
} as const;

const whenLabelStyle = {
  fontSize: '11px',
  fontWeight: '700',
  color: colors.textTertiary,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.07em',
  margin: '0 0 6px',
} as const;

const whenTextStyle = {
  fontSize: '14px',
  color: colors.textSecondary,
  margin: 0,
  lineHeight: '1.6',
} as const;

/**
 * Render the scheduled window as a single UTC line:
 *   with an end  → `Tue, 1 Sep 2026 · 10:00–11:00 (UTC)`
 *   without one  → `Tue, 1 Sep 2026 · 10:00 (UTC)`
 *
 * The end is OPTIONAL because the removal payload carries only `scheduledStartIso` — the
 * start alone identifies the call in that copy, and widening the payload for one line would
 * be the wrong trade. It renders a point in time rather than a degenerate `10:00–10:00`.
 *
 * ⚠ EXPLICIT `timeZone: 'UTC'`, NEVER THE HOST'S ZONE. A worker's `TZ` is an accident of
 * deployment, so an implicit zone would render a different instant on Railway than in CI —
 * and the reader would have no way to tell which. Stating UTC is honest and deterministic
 * (it is also why these tests pass on a non-UTC shell). A guest has no Balo profile and so
 * no stored timezone preference to localise to; per-recipient rendering needs a zone we do
 * not have.
 *
 * Degrades to the empty string on an unparseable instant rather than rendering
 * `Invalid Date` into somebody's inbox.
 */
export function formatMeetingWindowUtc(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return '';
  }
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(start);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const end = endIso === undefined ? undefined : new Date(endIso);
  if (end === undefined || Number.isNaN(end.getTime())) {
    return `${day} · ${time.format(start)} (UTC)`;
  }
  return `${day} · ${time.format(start)}–${time.format(end)} (UTC)`;
}

interface MeetingWhenBlockProps {
  readonly meetingTitle: string;
  readonly window: string;
}

/**
 * The shared "what and when" block. Title + UTC window; never a price.
 *
 * ⚠ THE LABEL IS ENGAGEMENT-TYPE-AGNOSTIC, AND IT HAS TO BE. `meetingTitle` is resolved from
 * the meeting's PRIMARY CONTEXT and falls back to `MEETING_LABEL_FOR_CONTEXT`, which yields
 * 'a project kickoff', 'a discovery call' or 'an intro call' as readily as 'a consultation'.
 * A hardcoded "The consultation" label therefore rendered `The consultation / a discovery
 * call` — the chrome contradicting the very value it introduces. Every Balo meeting is a
 * Daily video call, so "The video call" is both neutral across all six context types and
 * the only place the invite states the VENUE (a guest otherwise had no way to know whether
 * to expect a phone call, a room, or a link).
 */
function MeetingWhenBlock({ meetingTitle, window }: Readonly<MeetingWhenBlockProps>) {
  return (
    <Section style={whenBlockStyle}>
      <p style={whenLabelStyle}>The video call</p>
      <p style={whenTextStyle}>
        <strong>{meetingTitle}</strong>
        {window.length > 0 ? (
          <>
            <br />
            {window}
          </>
        ) : null}
      </p>
    </Section>
  );
}

/**
 * The greeting. Uses the guest's name when the inviter supplied one, and a generic "Hi
 * there," otherwise.
 *
 * ⚠ NEVER FALLS BACK TO THE EMAIL LOCAL PART. It would be the obvious convenience and it is
 * the same leak `projectGuestForViewer` refuses — and here it would additionally imply Balo
 * knows more about the reader than it does.
 */
function greetingFor(guestName?: string): string {
  const trimmed = guestName?.trim() ?? '';
  return trimmed.length > 0 ? `Hi ${trimmed},` : 'Hi there,';
}

// ── meeting.guest_invited ────────────────────────────────────────────────────────────

interface MeetingGuestInvitedEmailProps {
  readonly guestName?: string;
  readonly inviterName: string;
  readonly inviterOrgLabel: string;
  readonly meetingTitle: string;
  readonly scheduledStartIso: string;
  readonly scheduledEndIso: string;
  readonly accessScope: 'meeting' | 'engagement';
  readonly expiresOn: string;
  /** The CTA, and the ONLY credential-bearing string in the message. */
  readonly joinUrl: string;
  /** The SITE ORIGIN, for the shell's legal footer. ⚠ Never `joinUrl` — see the file docblock. */
  readonly baseUrl: string;
}

/**
 * Sent to an EXTERNAL person invited to a consultation. No Balo user row exists, so the
 * greeting degrades generically.
 *
 * The inviter is named as a RETROSPECTIVE PERSON "@ {org}" on first mention, bare name
 * after (CLAUDE.md's attribution rule), and gender-neutrally throughout.
 *
 * ⚠ THE ACCESS-SCOPE DISCLOSURE IS THE POINT OF THE `engagement` BRANCH, not decoration. An
 * `engagement`-scoped guest can read every consultation in the engagement — INCLUDING ONES
 * HELD BEFORE THEY WERE INVITED — and the whole mitigation for that retrospective grant is
 * that both the inviter and the guest are told so in plain language. Do not soften it.
 */
export function MeetingGuestInvitedEmail({
  guestName,
  inviterName,
  inviterOrgLabel,
  meetingTitle,
  scheduledStartIso,
  scheduledEndIso,
  accessScope,
  expiresOn,
  joinUrl,
  baseUrl,
}: Readonly<MeetingGuestInvitedEmailProps>) {
  // ⚠ NOT A BARE CONCATENATION. An INDEPENDENT expert has no agency, so the publisher sets
  // `inviterOrgLabel` to the person ("the person IS the party") — and `${name} @ ${org}`
  // then rendered "Dana Okoro @ Dana Okoro" in the inbox preview, the hero subtext and the
  // opening line. CLAUDE.md: "independent experts keep their own name."
  const inviterLabel = personWithOrgLabel(inviterName, inviterOrgLabel);
  const previewText = `${inviterLabel} invited you to "${meetingTitle}" on Balo.`;
  const window = formatMeetingWindowUtc(scheduledStartIso, scheduledEndIso);

  // ⚠ "this piece of work", NEVER "this case". The `engagement` grant is identical on a
  // `project_kickoff`, a `package_session` and a `retainer_checkin`; `case` is one of four
  // `engagement_type` values, and naming it would be wrong for three of them.
  const scopeText =
    accessScope === 'engagement'
      ? `You'll be able to read every call in this piece of work — recaps, transcripts and action items — including ones held before you were invited.`
      : `You'll be able to see this call and its recap. Nothing else from ${inviterOrgLabel} is shared with you.`;

  /**
   * ⚠ TWO FIXES LIVE IN THIS ONE STRING.
   *
   * (1) `expiresOn` DEFAULTS TO `''` at the template factory, and interpolating it
   *     unconditionally rendered "…works until . If…" — a sentence with a hole in it, in
   *     the most-forwarded message on the platform. The clause is guarded the same way
   *     `MeetingWhenBlock` guards `window`: present it or omit it, never render a stub.
   *
   * (2) THE WITHDRAWAL CLAUSE NAMES NO PERSON. It is PROSPECTIVE copy (what MAY happen),
   *     and CLAUDE.md's attribution rule puts prospective copy on the PARTY: the right to
   *     withdraw an invitation sits on company/agency membership (ADR-1029) and survives
   *     the individual inviter's departure, so "If {inviterName} removes you" was both
   *     factually narrow and faintly adversarial. The passive names nobody and stays true
   *     when someone else on that side does it.
   */
  const expiryClause = expiresOn.trim().length > 0 ? ` and works until ${expiresOn}` : '';
  const linkText = `This link is just for you${expiryClause}. If your invitation is withdrawn, the link stops working straight away.`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      {/* ── Hero ── */}
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="📅 You're invited" style={guestPillStyle} />
        <Heading style={shared.smallHeroHeading}>Join a video call</Heading>
        <Text style={shared.smallHeroSubtext}>{inviterLabel} invited you.</Text>
      </Section>

      {/* ── Body card ── */}
      <Section style={shared.card}>
        <Text style={shared.greeting}>{greetingFor(guestName)}</Text>
        <Text style={shared.bodyText}>
          {inviterLabel} invited you to join a video call on Balo. Open the link below when
          you&apos;re ready — it&apos;s yours, and it works before and during the call.
        </Text>

        <MeetingWhenBlock meetingTitle={meetingTitle} window={window} />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={joinUrl}>
            Open your invitation →
          </Button>
        </Section>

        <Callout
          emoji="🔎"
          heading="What you'll be able to see"
          text={scopeText}
          bg={colors.primaryLight}
          borderColor={colors.primaryBorder}
          headingColor={colors.primary}
        />

        <Callout
          emoji="🔗"
          heading="About this link"
          text={linkText}
          bg={colors.bg}
          borderColor={colors.border}
          headingColor={colors.textSecondary}
        />

        <SupportFooter prefix="Questions about this call?" />
      </Section>
    </EmailShell>
  );
}

// ── meeting.guest_removed ────────────────────────────────────────────────────────────

interface MeetingGuestRemovedEmailProps {
  readonly guestName?: string;
  readonly meetingTitle: string;
  readonly scheduledStartIso: string;
  /**
   * The SITE ORIGIN, for the shell's legal footer. There is no CTA in this message, but the
   * footer's Privacy / Terms links still need an absolute origin: an empty base rendered
   * them as `/legal/privacy`, which resolves to nothing at all inside a mail client.
   */
  readonly baseUrl: string;
}

/**
 * Sent to a guest whose access was revoked — to THAT PERSON ONLY.
 *
 * ⚠ BLAMELESS AND NON-ADVERSARIAL. The copy states the fact and offers a real next step
 * (talk to whoever invited you); it does not speculate about why, does not name who removed
 * them, and does not imply wrongdoing. Removal is routine — a call rescheduled, the wrong
 * address typed, a colleague going instead.
 *
 * ⚠ NO CTA LINK. Their link is dead by definition, and there is nothing else on Balo an
 * external non-user may open — a "sign in" button would be a dead end that implies an
 * account they do not have.
 */
export function MeetingGuestRemovedEmail({
  guestName,
  meetingTitle,
  scheduledStartIso,
  baseUrl,
}: Readonly<MeetingGuestRemovedEmailProps>) {
  const previewText = `Your invitation to "${meetingTitle}" has been withdrawn.`;
  // No end instant in this payload — see `formatMeetingWindowUtc`.
  const window = formatMeetingWindowUtc(scheduledStartIso);

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="Invitation withdrawn" style={guestPillStyle} />
        <Heading style={shared.smallHeroHeading}>You&apos;re no longer on this call</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>{greetingFor(guestName)}</Text>
        <Text style={shared.bodyText}>
          Your invitation to the call below has been withdrawn, so your join link won&apos;t work
          any more. If you think that&apos;s a mistake, the person who invited you can send a fresh
          invitation.
        </Text>

        <MeetingWhenBlock meetingTitle={meetingTitle} window={window} />

        <SupportFooter prefix="Need a hand?" />
      </Section>
    </EmailShell>
  );
}

// ── meeting.guest_link_resent ────────────────────────────────────────────────────────

interface MeetingGuestLinkResentEmailProps {
  readonly guestName?: string;
  readonly meetingTitle: string;
  readonly scheduledStartIso: string;
  readonly scheduledEndIso: string;
  readonly expiresOn: string;
  /** The CTA, and the ONLY credential-bearing string in the message. */
  readonly joinUrl: string;
  /** The SITE ORIGIN, for the shell's legal footer. ⚠ Never `joinUrl` — see the file docblock. */
  readonly baseUrl: string;
}

/**
 * BAL-436 — sent when a host re-sends the join link to a guest who was let in and never
 * arrived. The previous link has been ROTATED and no longer works.
 *
 * ⚠⚠ **NO INVITER IS NAMED, AND THAT IS NOT AN OMISSION.** This row was created by the
 * RECIPIENT themselves — they arrived holding the meeting link and asked to be let in — so
 * there is no inviter relationship to attribute. Naming the host who admitted them would
 * invent one, and CLAUDE.md's attribution rule puts prospective copy on the party anyway.
 *
 * ⚠ WARM, NOT ADVERSARIAL, AND NO COUNTDOWN. The expiry is stated as a helpful fact ("good
 * until {date}, no rush"), never as a deadline — the same framing the invite uses.
 *
 * ⚠ IT SAYS PLAINLY THAT THE OLD LINK IS DEAD. Rotation is invisible to the reader otherwise,
 * and somebody who keeps clicking a link that silently stopped working has a worse time than
 * somebody who was told.
 *
 * ⚠ NO BILLING LINE — see the file docblock. ⚠ Gender-neutral throughout.
 */
export function MeetingGuestLinkResentEmail({
  guestName,
  meetingTitle,
  scheduledStartIso,
  scheduledEndIso,
  expiresOn,
  joinUrl,
  baseUrl,
}: Readonly<MeetingGuestLinkResentEmailProps>) {
  const previewText = `Here's a fresh link for "${meetingTitle}".`;
  const window = formatMeetingWindowUtc(scheduledStartIso, scheduledEndIso);

  // ⚠ THE SAME GUARDED-CLAUSE SHAPE AS THE INVITE. `expiresOn` defaults to `''` at the
  // template factory, and interpolating it unconditionally renders "…good until . " — a
  // sentence with a hole in it. Present it or omit it; never render a stub.
  const expiryClause =
    expiresOn.trim().length > 0 ? ` It's good until ${expiresOn} — no rush.` : '';
  const linkText = `This link is just for you, and it replaces the one you had.${expiryClause}`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label="🔗 A fresh link" style={guestPillStyle} />
        <Heading style={shared.smallHeroHeading}>Here&apos;s a new way in</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>{greetingFor(guestName)}</Text>
        <Text style={shared.bodyText}>
          You&apos;ve been let into the call below. The link you had has stopped working, so
          here&apos;s a fresh one — open it whenever you&apos;re ready.
        </Text>

        <MeetingWhenBlock meetingTitle={meetingTitle} window={window} />

        <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
          <Button style={shared.smallCtaButton} href={joinUrl}>
            Join the call →
          </Button>
        </Section>

        <Callout
          emoji="🔗"
          heading="About this link"
          text={linkText}
          bg={colors.bg}
          borderColor={colors.border}
          headingColor={colors.textSecondary}
        />

        <SupportFooter prefix="Trouble getting in?" />
      </Section>
    </EmailShell>
  );
}
