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
import type { CalendarInviteTransition } from '../../calendar-invite-spec.js';
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

const invitePillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(37, 99, 235, 0.16)',
  border: '1px solid rgba(37, 99, 235, 0.34)',
  color: '#93C5FD',
};

function headingFor(transition: CalendarInviteEmailTransition): string {
  return transition === 'rescheduled'
    ? 'Your calendar invite has been updated'
    : 'Your calendar invite';
}

/**
 * F28 (fix round 1, UX3) — the pill changes with the transition, matching the sibling guest
 * emails' pattern (`meeting-guest-emails.tsx`'s "🕐 Time changed" vs "📅 You're invited"): a
 * reader scanning just the pill/subject-adjacent chrome can tell what happened without reading
 * the heading text.
 */
function pillLabelFor(transition: CalendarInviteEmailTransition): string {
  return transition === 'rescheduled' ? '🕐 Time changed' : '📅 Calendar invite';
}

function movedLineFor(transition: CalendarInviteEmailTransition): string | null {
  return transition === 'rescheduled'
    ? 'This call has moved — your calendar entry updates to the new time.'
    : null;
}

export function MeetingCalendarInviteEmail(props: Readonly<MeetingCalendarInviteEmailProps>) {
  const { recipientName, summary, startIso, endIso, transition, baseUrl, audience } = props;
  const window = formatMeetingWindowUtc(startIso, endIso);
  const heading = headingFor(transition);
  const pillLabel = pillLabelFor(transition);
  const movedLine = movedLineFor(transition);
  const previewText =
    transition === 'rescheduled'
      ? `Updated calendar invite: ${summary}`
      : `Calendar invite: ${summary}`;

  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={pillLabel} style={invitePillStyle} />
        <Heading style={shared.smallHeroHeading}>{heading}</Heading>
      </Section>

      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {recipientName},</Text>

        {/*
         * F26 (fix round 1, UX1/UX6) — ONE factual sentence, true for every (transition ×
         * audience) combination: it never claims a SPECIFIC other email exists (a rescheduled
         * intro call has no reschedule email; a guest's other email is their invitation, not a
         * "booking confirmation"). Included in the plain-text render for free — react-email
         * derives plain text from this same JSX tree.
         */}
        <Text style={{ ...shared.bodyText, color: colors.textSecondary, fontSize: '13px' }}>
          This short email carries the calendar file (.ics) attached below, so this call lands
          correctly in your own calendar app — it isn&apos;t a duplicate of anything else Balo has
          sent you.
        </Text>

        <MeetingWhenBlock meetingTitle={summary} window={window} />
        {movedLine === null ? null : <Text style={shared.bodyText}>{movedLine}</Text>}

        {audience === 'member' ? (
          <Section style={{ ...shared.ctaWrapper, margin: '24px 0 20px' }}>
            <Button style={shared.smallCtaButton} href={props.memberJoinUrl}>
              Open in Balo →
            </Button>
          </Section>
        ) : (
          <Text style={{ ...shared.bodyText, color: colors.textTertiary }}>
            {CALENDAR_INVITE_GUEST_JOIN_NOTE}
          </Text>
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
