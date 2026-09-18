import { Button, Heading, Section, Text } from '@react-email/components';
import {
  colors,
  shared,
  EmailShell,
  LogoRow,
  MeetingWhenBlock,
  StatusPill,
  SupportFooter,
} from './shared.js';
import { formatMeetingWindowUtc } from './meeting-guest-emails.js';
import { CALENDAR_INVITE_GUEST_JOIN_NOTE } from '../../calendar-invite-copy.js';
import {
  isCalendarInviteWithdrawal,
  type CalendarInviteTransition,
} from '../../calendar-invite-spec.js';
import type { CalendarInviteAudience } from '../../../services/calendar-invites/resolve-calendar-invite-facts.js';

/**
 * BAL-475 — the Balo-organised CALENDAR INVITE email. Rendered ONCE PER RECIPIENT by
 * `channels/calendar-invite-delivery.ts`, alongside the ICS attachment. This body is the
 * fallback for a client that ignores `text/calendar` entirely; the invite itself is the ICS.
 *
 * ⚠ NO BILLING LINE, NO ADDRESS, EVER — this template renders no counterparty contact
 * information of any kind (ADR-1044 §4 concealment applies to email bodies too).
 * ⚠ WARM, HELPFUL-FACT FRAMING, NO COUNTDOWN (CLAUDE.md copy rules).
 */

// F12 (fix round 1, R11) — re-exported under the template's own established names (so
// `templates/index.ts` and this file's test need no rename), but backed by the ONE canonical
// declaration instead of a second, independent union that could silently drift from it.
export type CalendarInviteEmailTransition = CalendarInviteTransition;
export type CalendarInviteEmailAudience = CalendarInviteAudience;

interface MeetingCalendarInviteEmailBaseProps {
  readonly recipientName: string;
  readonly summary: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly transition: CalendarInviteEmailTransition;
  readonly baseUrl: string;
}

/**
 * F29 (fix round 1, UX5) — a discriminated union on `audience`, not an independently-optional
 * `memberJoinUrl`. `resolveCalendarInviteFacts` ALREADY guarantees a `memberJoinUrl` for every
 * `audience: 'member'` fact (`memberJoinUrl: audience === 'member' ? joinUrl : undefined`), so
 * the old flat shape (`audience` × optional `memberJoinUrl`, independently) admitted a state
 * — a member with no join URL — that could never legitimately occur but that nothing stopped a
 * future regression from constructing, silently rendering the GUEST-only copy
 * ("…invitation email Balo sent you…") to a logged-in platform member. Making the mismatch a
 * compile error is cheaper than a runtime guard.
 */
export type MeetingCalendarInviteEmailProps = MeetingCalendarInviteEmailBaseProps &
  (
    | { readonly audience: 'member'; readonly memberJoinUrl: string }
    | { readonly audience: 'guest' }
  );

const ISSUE_ICS_NOTE =
  'This short email carries the calendar file (.ics) attached below, so this call lands ' +
  "correctly in your own calendar app — it isn't a duplicate of anything else Balo has sent you.";

const WITHDRAWAL_ICS_NOTE =
  'This short email carries the calendar file (.ics) attached below, so this call comes off ' +
  "your own calendar app — it isn't a duplicate of anything else Balo has sent you.";

const invitePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.16)',
  border: '1px solid rgba(37, 99, 235, 0.34)',
  color: '#93C5FD',
};

/**
 * ONE DATA TABLE for every transition's chrome — heading, pill, the one explanatory line, and the
 * subject/preview prefix.
 *
 * ⚠ A `Record` KEYED ON THE TRANSITION UNION, so a sixth transition is a compile error here
 * rather than a silently invite-shaped email for a withdrawal.
 *
 * F28 (fix round 1, UX3) — the pill changes with the transition, matching the sibling guest
 * emails' pattern (`meeting-guest-emails.tsx`'s "🕐 Time changed" vs "📅 You're invited"): a
 * reader scanning just the pill/subject-adjacent chrome can tell what happened without reading
 * the heading text.
 *
 * BAL-476 copy rules: gender-neutral, factual, never adversarial, never countdown-led. It says
 * what happened and what is now TRUE — and it never says WHY, because Balo does not know.
 */
export const TRANSITION_CHROME: Record<
  CalendarInviteEmailTransition,
  {
    readonly heading: string;
    readonly pill: string;
    readonly note: string | null;
    readonly previewPrefix: string;
  }
> = {
  booked: {
    heading: 'Your calendar invite',
    pill: '📅 Calendar invite',
    note: null,
    previewPrefix: 'Calendar invite',
  },
  guest_added: {
    heading: 'Your calendar invite',
    pill: '📅 Calendar invite',
    note: null,
    previewPrefix: 'Calendar invite',
  },
  rescheduled: {
    heading: 'Your calendar invite has been updated',
    pill: '🕐 Time changed',
    note: 'This call has moved — your calendar entry updates to the new time.',
    previewPrefix: 'Updated calendar invite',
  },
  cancelled: {
    heading: 'This call has been cancelled',
    pill: '🗓️ Cancelled',
    note: 'This call is no longer happening — your calendar entry is being removed.',
    previewPrefix: 'Cancelled',
  },
  guest_removed: {
    heading: 'Your invitation has been withdrawn',
    pill: '🗓️ Invitation withdrawn',
    note: 'You are no longer on this call — your calendar entry is being removed, and the invite link no longer works.',
    previewPrefix: 'Invitation withdrawn',
  },
};

export function MeetingCalendarInviteEmail(props: Readonly<MeetingCalendarInviteEmailProps>) {
  const { recipientName, summary, startIso, endIso, transition, baseUrl, audience } = props;
  const window = formatMeetingWindowUtc(startIso, endIso);
  const chrome = TRANSITION_CHROME[transition];
  // ⚠ ONE definition of "is this a withdrawal" — never a second
  // `=== 'cancelled' || === 'guest_removed'`.
  const isWithdrawal = isCalendarInviteWithdrawal(transition);
  const previewText = `${chrome.previewPrefix}: ${summary}`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={chrome.pill} style={invitePillStyle} />
        <Heading style={shared.smallHeroHeading}>{chrome.heading}</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {recipientName},</Text>

        {/*
         * F26 (fix round 1, UX1/UX6) — ONE factual sentence, true for every (transition ×
         * audience) combination: it never claims a SPECIFIC other email exists (a rescheduled
         * intro call has no reschedule email; a guest's other email is their invitation, not a
         * "booking confirmation"). Included in the plain-text render for free — react-email
         * derives plain text from this same JSX tree.
         *
         * BAL-476 — on a WITHDRAWAL the same file takes the entry OFF the reader's calendar, so
         * the sentence says so rather than claiming the call "lands correctly".
         */}
        <Text style={{ ...shared.bodyText, color: colors.textSecondary, fontSize: '13px' }}>
          {isWithdrawal ? WITHDRAWAL_ICS_NOTE : ISSUE_ICS_NOTE}
        </Text>

        {/* ⚠ The reader still needs to know WHICH call — kept on every transition. */}
        <MeetingWhenBlock meetingTitle={summary} window={window} />
        {chrome.note === null ? null : <Text style={shared.bodyText}>{chrome.note}</Text>}

        {/*
         * ⚠⚠ BAL-476 — THE JOIN AFFORDANCE IS SUPPRESSED ON A WITHDRAWAL, for members AND for
         * guests. Offering a way into a call that is cancelled (or that this person is no longer
         * on) is the one thing this copy must not do.
         */}
        {isWithdrawal ? null : (
          <JoinAffordance
            audience={audience}
            memberJoinUrl={audience === 'member' ? props.memberJoinUrl : undefined}
          />
        )}

        <Text style={{ ...shared.bodyText, fontSize: '13px', color: colors.textTertiary }}>
          Rescheduling and cancelling happen in Balo. Replying to this invite does not change
          anything.
        </Text>

        <SupportFooter prefix="Questions about this call?" />
      </Section>
    </EmailShell>
  );
}

/** The member CTA / guest note pair — extracted so the withdrawal suppression is ONE branch. */
function JoinAffordance(
  props: Readonly<{ audience: CalendarInviteEmailAudience; memberJoinUrl: string | undefined }>
) {
  if (props.audience === 'member') {
    return (
      <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
        <Button style={shared.smallCtaButton} href={props.memberJoinUrl}>
          Open in Balo →
        </Button>
      </Section>
    );
  }
  return (
    <Text style={{ ...shared.bodyText, color: colors.textTertiary }}>
      {CALENDAR_INVITE_GUEST_JOIN_NOTE}
    </Text>
  );
}
