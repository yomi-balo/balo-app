import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import {
  MeetingCalendarInviteEmail,
  TRANSITION_CHROME,
  type CalendarInviteEmailTransition,
} from './meeting-calendar-invite.js';
import { CALENDAR_INVITE_TRANSITIONS } from '../../calendar-invite-spec.js';
import { getEmailTemplate } from './index.js';

const START = '2026-09-01T10:00:00.000Z';
const END = '2026-09-01T11:00:00.000Z';
const SITE = 'https://app.balo.expert';

type Props = Parameters<typeof MeetingCalendarInviteEmail>[0];

/** Member-audience fixture (F29 — the union's `member` arm requires `memberJoinUrl`). */
function memberProps(
  over: Partial<{
    recipientName: string;
    summary: string;
    startIso: string;
    endIso: string;
    transition: CalendarInviteEmailTransition;
    memberJoinUrl: string;
    baseUrl: string;
  }> = {}
): Props {
  return {
    recipientName: 'Dana',
    summary: 'Consultation with Northwind Industrial',
    startIso: START,
    endIso: END,
    transition: 'booked',
    audience: 'member',
    memberJoinUrl: `${SITE}/meetings/meeting-1/call`,
    baseUrl: SITE,
    ...over,
  };
}

/** Guest-audience fixture (F29 — the union's `guest` arm carries no `memberJoinUrl` at all). */
function guestProps(
  over: Partial<{
    recipientName: string;
    summary: string;
    startIso: string;
    endIso: string;
    transition: CalendarInviteEmailTransition;
    baseUrl: string;
  }> = {}
): Props {
  return {
    recipientName: 'Dana',
    summary: 'Consultation with Northwind Industrial',
    startIso: START,
    endIso: END,
    transition: 'booked',
    audience: 'guest',
    baseUrl: SITE,
    ...over,
  };
}

// Kept for call sites below that don't care which audience they exercise.
const baseProps = memberProps;

/** Every `href="..."` value found in the rendered HTML. */
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string);
}

describe('getEmailTemplate("meeting-calendar-invite") — subjects', () => {
  it('booked: "Calendar invite: {summary}"', () => {
    const { subject } = getEmailTemplate('meeting-calendar-invite', {
      summary: 'Consultation with Northwind Industrial',
      transition: 'booked',
    });
    expect(subject).toBe('Calendar invite: Consultation with Northwind Industrial');
  });

  it('guest_added: same "Calendar invite: {summary}" form', () => {
    const { subject } = getEmailTemplate('meeting-calendar-invite', {
      summary: 'Consultation with Northwind Industrial',
      transition: 'guest_added',
    });
    expect(subject).toBe('Calendar invite: Consultation with Northwind Industrial');
  });

  it('rescheduled: "Updated calendar invite: {summary}"', () => {
    const { subject } = getEmailTemplate('meeting-calendar-invite', {
      summary: 'Consultation with Northwind Industrial',
      transition: 'rescheduled',
    });
    expect(subject).toBe('Updated calendar invite: Consultation with Northwind Industrial');
  });
});

describe('MeetingCalendarInviteEmail', () => {
  it('member audience: the "Open in Balo" CTA href is the memberJoinUrl', async () => {
    const html = await render(MeetingCalendarInviteEmail(memberProps()));
    expect(hrefsIn(html)).toContain(`${SITE}/meetings/meeting-1/call`);
  });

  it('guest audience: no /join/ href anywhere in the render', async () => {
    const html = await render(MeetingCalendarInviteEmail(guestProps()));
    expect(hrefsIn(html).some((href) => href.includes('/join/'))).toBe(false);
    expect(html).toContain('invitation email Balo sent you');
  });

  it('rescheduled: renders the "this call has moved" line', async () => {
    const html = await render(MeetingCalendarInviteEmail(baseProps({ transition: 'rescheduled' })));
    expect(html).toContain('This call has moved');
  });

  it('booked: does NOT render the moved line', async () => {
    const html = await render(MeetingCalendarInviteEmail(baseProps({ transition: 'booked' })));
    expect(html).not.toContain('This call has moved');
  });

  it('baseUrl footer links are site-origin (the href-sweep pattern)', async () => {
    const html = await render(MeetingCalendarInviteEmail(baseProps()));
    const footerHrefs = hrefsIn(html).filter((href) => href.includes('/legal/'));
    expect(footerHrefs.length).toBeGreaterThan(0);
    for (const href of footerHrefs) {
      expect(href.startsWith(SITE)).toBe(true);
    }
  });

  it('never renders a billing figure', async () => {
    const html = await render(MeetingCalendarInviteEmail(baseProps()));
    expect(html).not.toMatch(/\$\d/);
  });

  // ── F26 (fix round 1, UX1/UX6) — the "why a second email" explanation ──────────

  const SECOND_EMAIL_SENTENCE_FRAGMENT = 'carries the calendar file (.ics)';

  it.each(['booked', 'guest_added', 'rescheduled'] as const)(
    'F26 — member audience, transition %s: explains this email carries the calendar file, in BOTH html and plain text',
    async (transition) => {
      const props = memberProps({ transition });
      const html = await render(MeetingCalendarInviteEmail(props));
      const text = await render(MeetingCalendarInviteEmail(props), { plainText: true });
      expect(html).toContain(SECOND_EMAIL_SENTENCE_FRAGMENT);
      expect(text).toContain(SECOND_EMAIL_SENTENCE_FRAGMENT);
      // Never claims a SPECIFIC other email exists.
      expect(html).not.toContain('booking confirmation');
    }
  );

  it.each(['booked', 'guest_added', 'rescheduled'] as const)(
    'F26 — guest audience, transition %s: explains this email carries the calendar file, in BOTH html and plain text',
    async (transition) => {
      const props = guestProps({ transition });
      const html = await render(MeetingCalendarInviteEmail(props));
      const text = await render(MeetingCalendarInviteEmail(props), { plainText: true });
      expect(html).toContain(SECOND_EMAIL_SENTENCE_FRAGMENT);
      expect(text).toContain(SECOND_EMAIL_SENTENCE_FRAGMENT);
      expect(html).not.toContain('booking confirmation');
    }
  );

  // ── F27 (fix round 1, UX2) — reuses the sibling MeetingWhenBlock ────────────────

  it('F27 — renders the boxed "The video call" venue label (from the shared MeetingWhenBlock)', async () => {
    const html = await render(MeetingCalendarInviteEmail(memberProps()));
    expect(html).toContain('The video call');
    expect(html).toContain('Consultation with Northwind Industrial');
  });

  // ── F28 (fix round 1, UX3) — the status pill changes with the transition ───────

  it('F28 — booked: the pill reads "📅 Calendar invite"', async () => {
    const html = await render(MeetingCalendarInviteEmail(memberProps({ transition: 'booked' })));
    expect(html).toContain('Calendar invite');
  });

  it('F28 — rescheduled: the pill reads "🕐 Time changed", matching the sibling guest email\'s treatment', async () => {
    const html = await render(
      MeetingCalendarInviteEmail(memberProps({ transition: 'rescheduled' }))
    );
    expect(html).toContain('Time changed');
  });

  // ── F29 (fix round 1, UX5) — a compile-time guard, not just a runtime one ──────

  it('F29 — the guest arm renders no memberJoinUrl-shaped href, by TYPE (guestProps carries no such field at all)', async () => {
    // If `guestProps` could accidentally admit a `memberJoinUrl` key, TypeScript would already
    // have refused this file to compile — the type-level half of the fix. This is the runtime
    // half: the CTA branch is genuinely unreachable for a guest.
    const html = await render(MeetingCalendarInviteEmail(guestProps()));
    expect(html).not.toContain('Open in Balo');
  });
});

// ── BAL-476 — the two WITHDRAWAL transitions ──────────────────────────────────────────────

describe('TRANSITION_CHROME — the one data table', () => {
  it('⚠ is TOTAL over CALENDAR_INVITE_TRANSITIONS (a length assertion guards a vacuous pass)', () => {
    const keys = Object.keys(TRANSITION_CHROME);
    expect(keys).toHaveLength(CALENDAR_INVITE_TRANSITIONS.length);
    expect(CALENDAR_INVITE_TRANSITIONS).toHaveLength(5);
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(
      [...CALENDAR_INVITE_TRANSITIONS].sort((a, b) => a.localeCompare(b))
    );
  });
});

describe('getEmailTemplate("meeting-calendar-invite") — withdrawal subjects (BAL-476)', () => {
  it('cancelled: "Cancelled: {summary}" — never an invite-shaped subject', () => {
    const { subject } = getEmailTemplate('meeting-calendar-invite', {
      summary: 'Consultation with Northwind Industrial',
      transition: 'cancelled',
    });
    expect(subject).toBe('Cancelled: Consultation with Northwind Industrial');
    expect(subject).not.toContain('Calendar invite');
  });

  it('guest_removed: "Invitation withdrawn: {summary}"', () => {
    const { subject } = getEmailTemplate('meeting-calendar-invite', {
      summary: 'Consultation with Northwind Industrial',
      transition: 'guest_removed',
    });
    expect(subject).toBe('Invitation withdrawn: Consultation with Northwind Industrial');
  });
});

describe('MeetingCalendarInviteEmail — the withdrawal body (BAL-476)', () => {
  const WITHDRAWALS = ['cancelled', 'guest_removed'] as const;

  it('cancelled: the heading and the note say the call is off', async () => {
    const html = await render(MeetingCalendarInviteEmail(memberProps({ transition: 'cancelled' })));
    expect(html).toContain('This call has been cancelled');
    expect(html).toContain('This call is no longer happening');
    expect(html).toContain('Cancelled');
  });

  it('guest_removed: the heading and the note say the invitation is withdrawn', async () => {
    const html = await render(
      MeetingCalendarInviteEmail(guestProps({ transition: 'guest_removed' }))
    );
    expect(html).toContain('Your invitation has been withdrawn');
    expect(html).toContain('You are no longer on this call');
    expect(html).toContain('the invite link no longer works');
  });

  /**
   * ⚠⚠ THE ONE THING THE WITHDRAWAL COPY MUST NOT DO: offer a way INTO a call that is cancelled,
   * or that this person is no longer on.
   */
  it.each(WITHDRAWALS)(
    '⚠ %s, member audience: NO "Open in Balo" CTA and no /join/ href',
    async (transition) => {
      const html = await render(MeetingCalendarInviteEmail(memberProps({ transition })));
      expect(html).not.toContain('Open in Balo');
      expect(hrefsIn(html).some((href) => href.includes('/join/'))).toBe(false);
    }
  );

  it.each(WITHDRAWALS)('⚠ %s, guest audience: NO guest join note', async (transition) => {
    const html = await render(MeetingCalendarInviteEmail(guestProps({ transition })));
    expect(html).not.toContain('invitation email Balo sent you');
    expect(hrefsIn(html).some((href) => href.includes('/join/'))).toBe(false);
  });

  it.each(WITHDRAWALS)(
    '%s: the .ics sentence says the entry comes OFF the calendar, in BOTH html and plain text',
    async (transition) => {
      const props = memberProps({ transition });
      const html = await render(MeetingCalendarInviteEmail(props));
      const text = await render(MeetingCalendarInviteEmail(props), { plainText: true });
      expect(html).toContain('comes off your own calendar app');
      expect(text).toContain('comes off your own calendar app');
      expect(html).not.toContain('lands correctly in your own calendar app');
    }
  );

  it.each(WITHDRAWALS)('%s: still names WHICH call — the when-block stays', async (transition) => {
    const html = await render(MeetingCalendarInviteEmail(memberProps({ transition })));
    expect(html).toContain('Consultation with Northwind Industrial');
  });

  /** ⚠ It says what happened and what is now true. It NEVER says why — Balo does not know. */
  it.each(WITHDRAWALS)('⚠ %s: never editorialises about WHY', async (transition) => {
    const html = await render(MeetingCalendarInviteEmail(memberProps({ transition })));
    for (const forbidden of ['because', 'removed you', 'kicked', 'banned', 'denied']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it.each(WITHDRAWALS)(
    '%s: keeps the "rescheduling and cancelling happen in Balo" footer',
    async (transition) => {
      const html = await render(MeetingCalendarInviteEmail(memberProps({ transition })));
      expect(html).toContain('Rescheduling and cancelling happen in Balo');
    }
  );
});
