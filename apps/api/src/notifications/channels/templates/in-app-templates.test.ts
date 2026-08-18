import { describe, it, expect } from 'vitest';
import { getInAppTemplate } from './in-app-templates.js';

describe('getInAppTemplate', () => {
  describe('booking-confirmed', () => {
    it('returns correct title and body with client name', () => {
      const result = getInAppTemplate('booking-confirmed', {
        clientName: 'Alice',
        caseId: 'case-123',
      });
      expect(result).toEqual({
        title: 'New booking',
        body: 'Alice booked a consultation',
        actionUrl: '/cases/case-123',
      });
    });

    it('falls back to "A client" when clientName is missing', () => {
      const result = getInAppTemplate('booking-confirmed', {});
      expect(result.body).toBe('A client booked a consultation');
    });

    it('omits actionUrl when caseId is missing', () => {
      const result = getInAppTemplate('booking-confirmed', { clientName: 'Bob' });
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('new-message', () => {
    it('returns correct title, body, and actionUrl', () => {
      const result = getInAppTemplate('new-message', { caseId: 'case-456' });
      expect(result).toEqual({
        title: 'New message',
        body: 'You have a new message in your consultation',
        actionUrl: '/cases/case-456',
      });
    });

    it('omits actionUrl when caseId is missing', () => {
      const result = getInAppTemplate('new-message', {});
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-exploratory-requested', () => {
    it('returns the title, body, and action url', () => {
      const result = getInAppTemplate('project-exploratory-requested', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Book your exploratory call',
        body: 'Balo wants a quick call about "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-exploratory-requested', {});
      expect(result.body).toBe('Balo wants a quick call about "your project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-eoi-submitted', () => {
    it('returns the title, body (with expert name), and action url', () => {
      const result = getInAppTemplate('project-eoi-submitted', {
        title: 'CPQ implementation',
        expertName: 'Priya Nair',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'An expert is interested',
        body: 'Priya Nair expressed interest in "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when expertName/title are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-eoi-submitted', {});
      expect(result.body).toBe('An expert expressed interest in "your project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-expert-invited', () => {
    it('returns the title, body, and action url', () => {
      const result = getInAppTemplate('project-expert-invited', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: "You're invited to a project",
        body: 'Balo invited you to express interest in "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-expert-invited', {});
      expect(result.body).toBe('Balo invited you to express interest in "a new project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-requested', () => {
    it('returns the title, body, and action url', () => {
      const result = getInAppTemplate('project-proposal-requested', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal requested',
        body: 'The client requested your proposal for "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-proposal-requested', {});
      expect(result.body).toBe('The client requested your proposal for "a project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-requested-client', () => {
    it('returns the client heads-up title, body, and action url (BAL-315)', () => {
      const result = getInAppTemplate('project-proposal-requested-client', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal requested for you',
        body: 'Balo asked an expert to send a proposal for "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back to "your project" when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-proposal-requested-client', {});
      expect(result.body).toBe('Balo asked an expert to send a proposal for "your project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-submitted', () => {
    it('returns the title, body (with expert name), and action url', () => {
      const result = getInAppTemplate('project-proposal-submitted', {
        title: 'CPQ implementation',
        expertName: 'Priya Nair',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal received',
        body: 'Priya Nair sent a proposal for "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when expertName/title are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-proposal-submitted', {});
      expect(result.body).toBe('Your expert sent a proposal for "a project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-accepted', () => {
    it('returns the winning-expert title, body, and action url', () => {
      const result = getInAppTemplate('project-proposal-accepted', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal accepted',
        body: 'Your proposal for "CPQ implementation" was accepted',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-proposal-accepted', {});
      expect(result.body).toBe('Your proposal for "a project" was accepted');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-kickoff-approved-expert', () => {
    it('returns the expert title, body, and action url', () => {
      const result = getInAppTemplate('project-kickoff-approved-expert', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Kickoff approved',
        body: 'Kickoff approved for "CPQ implementation" — time to deliver',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-kickoff-approved-expert', {});
      expect(result.body).toBe('Kickoff approved for "a project" — time to deliver');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-kickoff-approved-client', () => {
    it('returns the client title, body (with expert name), and action url', () => {
      const result = getInAppTemplate('project-kickoff-approved-client', {
        title: 'CPQ implementation',
        expertName: 'Priya Nair',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Kickoff approved',
        body: 'Priya Nair is ready — kickoff approved for "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when expertName/title are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-kickoff-approved-client', {});
      expect(result.body).toBe('Your expert is ready — kickoff approved for "a project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-not-selected', () => {
    it('returns the not-selected title, body, and action url', () => {
      const result = getInAppTemplate('project-proposal-not-selected', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal not selected',
        body: 'The client chose another proposal for "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the title is missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-proposal-not-selected', {});
      expect(result.body).toBe('The client chose another proposal for "a project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-proposal-accepted-admin', () => {
    it('returns the ops title, body (with "client @ company" + formatted price), and action url', () => {
      const result = getInAppTemplate('project-proposal-accepted-admin', {
        clientName: 'Dana Whitfield',
        clientCompanyName: 'Acme Corp',
        title: 'CPQ implementation',
        priceCents: 120000,
        currency: 'aud',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Proposal accepted — raise invoice',
        body: 'Dana Whitfield @ Acme Corp accepted a proposal for "CPQ implementation" (AUD 1,200)',
        actionUrl: '/projects/req-1',
      });
    });

    it('degrades to the bare client name when clientCompanyName is absent', () => {
      const result = getInAppTemplate('project-proposal-accepted-admin', {
        clientName: 'Dana Whitfield',
        title: 'CPQ implementation',
        priceCents: 120000,
        currency: 'aud',
        projectRequestId: 'req-1',
      });
      expect(result.body).toBe(
        'Dana Whitfield accepted a proposal for "CPQ implementation" (AUD 1,200)'
      );
    });

    it('falls back gracefully when client name, company, price, and currency are missing', () => {
      const result = getInAppTemplate('project-proposal-accepted-admin', {
        title: 'CPQ implementation',
      });
      expect(result.body).toBe('A client accepted a proposal for "CPQ implementation" (an amount)');
      expect(result.actionUrl).toBeUndefined();
    });

    it('renders the currency code alone when the price is non-numeric', () => {
      const result = getInAppTemplate('project-proposal-accepted-admin', {
        clientName: 'Dana',
        title: 'CPQ',
        priceCents: 'oops',
        currency: 'usd',
        projectRequestId: 'req-1',
      });
      expect(result.body).toBe('Dana accepted a proposal for "CPQ" (USD)');
    });
  });

  describe('conversation-message-posted', () => {
    it('renders sender + preview with the REQUEST action url on the relationship arm', () => {
      const result = getInAppTemplate('conversation-message-posted', {
        senderName: 'Priya Nair',
        preview: 'Quick question about the CPQ scope',
        contextType: 'relationship',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'New message',
        body: 'Priya Nair: Quick question about the CPQ scope',
        actionUrl: '/projects/req-1',
      });
    });

    /**
     * ⚠ BAL-424: the deep link is CHOSEN BY THE ANCHOR. A Case has no request, so the old
     * unconditional `/projects/${projectRequestId}` produced a dead link for exactly the
     * surface this event was generalised for.
     */
    it('deep-links the ENGAGEMENT on the engagement arm', () => {
      const result = getInAppTemplate('conversation-message-posted', {
        senderName: 'Priya Nair',
        preview: 'On the migration plan',
        contextType: 'engagement',
        engagementId: 'eng-1',
      });
      expect(result.actionUrl).toBe('/engagements/eng-1');
    });

    it('falls back to contextId when the engagement arm omits engagementId', () => {
      const result = getInAppTemplate('conversation-message-posted', {
        contextType: 'engagement',
        contextId: 'eng-2',
      });
      expect(result.actionUrl).toBe('/engagements/eng-2');
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('conversation-message-posted', {});
      expect(result.body).toBe('Someone: sent you a message');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('conversation-file-shared', () => {
    it('renders sender + file name with the REQUEST action url on the relationship arm', () => {
      const result = getInAppTemplate('conversation-file-shared', {
        senderName: 'Dana Whitfield',
        fileName: 'price-book-export.xlsx',
        contextType: 'relationship',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'New file shared',
        body: 'Dana Whitfield shared price-book-export.xlsx',
        actionUrl: '/projects/req-1',
      });
    });

    it('deep-links the ENGAGEMENT on the engagement arm', () => {
      const result = getInAppTemplate('conversation-file-shared', {
        senderName: 'Dana Whitfield',
        fileName: 'notes.pdf',
        contextType: 'engagement',
        engagementId: 'eng-1',
      });
      expect(result.actionUrl).toBe('/engagements/eng-1');
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('conversation-file-shared', {});
      expect(result.body).toBe('Someone shared a file');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-billing-reminder-owner (BAL-324)', () => {
    it('renders the owner "complete billing" prompt with the request action url', () => {
      const result = getInAppTemplate('project-billing-reminder-owner', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Complete your billing details',
        body: 'Add your billing details to kick off "CPQ implementation"',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-billing-reminder-owner', {});
      expect(result.body).toBe('Add your billing details to kick off "your project"');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-billing-reminder-creator (BAL-324)', () => {
    it('renders the creator FYI with the request action url', () => {
      const result = getInAppTemplate('project-billing-reminder-creator', {
        title: 'CPQ implementation',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Billing details still needed',
        body: '"CPQ implementation" is on hold until your company\'s billing details are added',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-billing-reminder-creator', {});
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('billing-details-confirmed-admin (BAL-323)', () => {
    it('renders the company name, ready-to-invoice body, and deep link', () => {
      const result = getInAppTemplate('billing-details-confirmed-admin', {
        companyName: 'Acme Pty Ltd',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'Billing details confirmed',
        body: 'Billing details confirmed for Acme Pty Ltd — ready to invoice.',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when the company name is missing and omits the url without an id', () => {
      const result = getInAppTemplate('billing-details-confirmed-admin', {});
      expect(result.body).toBe('Billing details confirmed for a company — ready to invoice.');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('calendar-subscription-lapse-admin (BAL-468)', () => {
    it('renders both counts in the body', () => {
      const result = getInAppTemplate('calendar-subscription-lapse-admin', {
        expiringCount: 3,
        unconfirmedCount: 1,
        unsubscribedConnectionCount: 2,
      });
      expect(result).toEqual({
        title: 'Calendar subscriptions need attention',
        body: '3 calendar subscription(s) expire within 48 hours and 2 connection(s) have none — the renewal sweep may be falling behind.',
      });
    });

    it('degrades every field to 0 on empty data — never NaN/undefined', () => {
      const result = getInAppTemplate('calendar-subscription-lapse-admin', {});
      expect(result.body).toBe(
        '0 calendar subscription(s) expire within 48 hours and 0 connection(s) have none — the renewal sweep may be falling behind.'
      );
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('credit-dormancy-reminder (BAL-380)', () => {
    it('renders the 60-day copy with the formatted balance + short date', () => {
      const result = getInAppTemplate('credit-dormancy-reminder', {
        window: 60,
        balanceMinor: 34700,
        expiresAt: '2027-07-12T00:00:00.000Z',
      });
      expect(result).toEqual({
        title: 'Your balance is still here',
        body: 'A$347.00, available until 12 Jul 2027. Any activity keeps it going.',
        actionUrl: '/experts',
      });
    });

    it('renders the 30-day copy with the date in the title', () => {
      const result = getInAppTemplate('credit-dormancy-reminder', {
        window: 30,
        balanceMinor: 34700,
        expiresAt: '2027-07-12T00:00:00.000Z',
      });
      expect(result).toEqual({
        title: 'Your balance stays available until 12 Jul 2027',
        body: 'A$347.00 is still here. A good time to put it to use.',
        actionUrl: '/experts',
      });
    });

    it('defaults to the 60-day variant and degrades a missing balance to A$0.00', () => {
      const result = getInAppTemplate('credit-dormancy-reminder', {
        expiresAt: '2027-07-12T00:00:00.000Z',
      });
      expect(result.title).toBe('Your balance is still here');
      expect(result.body).toContain('A$0.00');
    });
  });

  describe('credit-balance-expired (BAL-380)', () => {
    it('renders the soft, provisional copy with no balance figure', () => {
      const result = getInAppTemplate('credit-balance-expired', {
        expiresAt: '2027-07-12T00:00:00.000Z',
      });
      expect(result).toEqual({
        title: 'About your balance',
        body: 'Your balance reached its expiry date. Add credit to pick back up anytime.',
        actionUrl: '/settings/billing',
      });
      expect(result.body).not.toMatch(/A\$\d/);
    });
  });

  describe('engagement-case-closed-client (BAL-390)', () => {
    it('renders the resolved-close record, deep-linked to the MEETING RECAP', () => {
      const result = getInAppTemplate('engagement-case-closed-client', {
        caseTitle: 'Flow interview stuck on a record-triggered loop',
        closedDate: '3 Aug',
        closeReason: 'resolved',
        engagementId: 'eng-1',
        meetingId: 'mtg-1',
      });
      expect(result).toEqual({
        title: 'Case closed',
        body: "'Flow interview stuck on a record-triggered loop' is wrapped up as of 3 Aug. Everything from it stays here whenever you need it.",
        // NOT `/engagements/eng-1` — that route 404s for a CASE by construction (BAL-388).
        actionUrl: '/meetings/mtg-1?from=notification',
      });
    });

    it('renders NO actionUrl when the payload carries no meetingId', () => {
      const result = getInAppTemplate('engagement-case-closed-client', {
        caseTitle: 'Apex CPU limit',
        closedDate: '3 Aug',
        closeReason: 'resolved',
        engagementId: 'eng-9',
      });
      expect(result.actionUrl).toBeUndefined();
    });

    it('softens the copy when the case went quiet rather than being resolved', () => {
      const result = getInAppTemplate('engagement-case-closed-client', {
        caseTitle: 'Apex CPU limit',
        closedDate: '3 Aug',
        closeReason: 'auto_inactive',
        engagementId: 'eng-2',
      });
      expect(result.body).toContain('had been quiet for a while');
      expect(result.body).toContain('rather than leave it hanging');
    });

    it('carries NO star row and NO review token — those live in the email only', () => {
      const result = getInAppTemplate('engagement-case-closed-client', {
        caseTitle: 'Apex CPU limit',
        closedDate: '3 Aug',
        closeReason: 'resolved',
        engagementId: 'eng-3',
        reviewToken: 'raw-token-value-that-must-not-render',
      });
      expect(JSON.stringify(result)).not.toContain('raw-token-value');
      expect(JSON.stringify(result)).not.toContain('/review/');
    });

    it('degrades gracefully with no payload fields', () => {
      const result = getInAppTemplate('engagement-case-closed-client', {});
      expect(result.title).toBe('Case closed');
      expect(result.body).toContain("'Your case'");
      expect(result.body).toContain('today');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  /**
   * BAL-388 — the recap's PRIMARY in-app entry point. `getInAppTemplate` silently falls back to
   * a generic notice for an unknown name, so an untested arm degrades to a meaningless
   * notification with a green CI: these assert the REAL title, body and deep link.
   */
  describe('recap-ready (BAL-387 / BAL-388)', () => {
    it('deep-links the MEETING recap and tags the entry source', () => {
      const result = getInAppTemplate('recap-ready', {
        meetingId: 'mtg-1',
        actionItemCount: 2,
        summaryHeadline: 'Agreed to migrate CPQ config.',
      });
      expect(result).toEqual({
        title: 'Session recap ready',
        body: 'Agreed to migrate CPQ config. · 2 action items',
        actionUrl: '/meetings/mtg-1?from=notification',
      });
    });

    it('uses the singular action-item noun for exactly one', () => {
      const result = getInAppTemplate('recap-ready', { meetingId: 'mtg-2', actionItemCount: 1 });
      expect(result.body).toBe('Your session summary is ready · 1 action item.');
    });

    it('renders NO actionUrl when the payload carries no meetingId', () => {
      const result = getInAppTemplate('recap-ready', { actionItemCount: 0 });
      expect(result.actionUrl).toBeUndefined();
      expect(result.title).toBe('Session recap ready');
    });
  });

  /**
   * BAL-408 — the same-party "a guest was added" FYI.
   *
   * ⚠⚠ THE POINT OF THIS BLOCK IS THAT A MISSING IN-APP TEMPLATE DOES NOT THROW. `getInAppTemplate`
   * returns the generic `{ title: 'Notification', body: 'You have a new notification' }`
   * fallback for any unregistered name, so a rule that names a template nobody wrote ships
   * green through typecheck, lint and the rules test — and degrades silently in production
   * into a notification bell that says nothing. Asserting the REAL strings (and explicitly
   * refuting the fallback) is the only thing that catches it.
   */
  describe('meeting-guest-added (BAL-408)', () => {
    const FALLBACK = { title: 'Notification', body: 'You have a new notification' };

    it('⚠ returns the REAL title and body — NOT the generic missing-template fallback', () => {
      const result = getInAppTemplate('meeting-guest-added', {
        guestDisplayName: 'Dana',
        meetingTitle: 'CPQ implementation',
      });

      expect(result).toEqual({
        title: 'Someone new is joining',
        body: 'Dana was added to CPQ implementation.',
      });
      expect(result).not.toEqual(FALLBACK);
      expect(result.title).not.toBe(FALLBACK.title);
      expect(result.body).not.toBe(FALLBACK.body);
    });

    it('falls back to the neutral noun for a nameless guest — NEVER to an address', () => {
      // `announceInvites` already substitutes "A guest" for a null name; this is the second
      // line of the same defence, for a publisher that omits the key entirely.
      const result = getInAppTemplate('meeting-guest-added', {
        meetingTitle: 'CPQ implementation',
      });

      expect(result.body).toBe('Someone was added to CPQ implementation.');
      expect(result.body).not.toContain('@');
    });

    it('falls back to a generic meeting noun when the title did not resolve', () => {
      const result = getInAppTemplate('meeting-guest-added', { guestDisplayName: 'Dana' });

      expect(result.body).toBe('Dana was added to your consultation.');
      expect(result).not.toEqual(FALLBACK);
    });

    it('degrades on an entirely empty payload without reaching the fallback', () => {
      const result = getInAppTemplate('meeting-guest-added', {});

      expect(result.body).toBe('Someone was added to your consultation.');
      expect(result).not.toEqual(FALLBACK);
    });

    it('⚠ carries NO actionUrl — there is no meeting surface to deep-link to yet', () => {
      // BAL-421 / BAL-132 own that surface. A link to nowhere is worse than none.
      const result = getInAppTemplate('meeting-guest-added', {
        guestDisplayName: 'Dana',
        meetingTitle: 'CPQ implementation',
      });

      expect(result.actionUrl).toBeUndefined();
    });

    it('⚠ never renders an email address or a join token, even when handed one', () => {
      // The publisher does not send either; this pins that a future one that did would not
      // have them surface on a shared, same-party in-app card.
      const result = getInAppTemplate('meeting-guest-added', {
        guestDisplayName: 'Dana',
        meetingTitle: 'CPQ implementation',
        recipientEmail: 'dana@northwind.example',
        joinToken: 'raw-token-value-that-must-not-render',
      });

      expect(JSON.stringify(result)).not.toContain('dana@northwind.example');
      expect(JSON.stringify(result)).not.toContain('raw-token-value');
    });
  });

  describe('calendar-reconnect-required (BAL-396 §7)', () => {
    it('names the Google label and deep-links to the calendar settings tab', () => {
      const result = getInAppTemplate('calendar-reconnect-required', { provider: 'google' });
      expect(result).toEqual({
        title: 'Reconnect your calendar',
        body: "Balo lost access to your Google Calendar — your availability is paused until it's reconnected.",
        actionUrl: '/expert/settings?tab=calendar',
      });
    });

    it('names the Microsoft 365 label', () => {
      const result = getInAppTemplate('calendar-reconnect-required', { provider: 'microsoft' });
      expect(result.body).toContain('Microsoft 365 calendar');
    });

    /**
     * ⚠ BAL-396 FIX ROUND — THE DOUBLED-NOUN REGRESSION TEST. "your Google Calendar
     * calendar" / "your calendar calendar" used to be PINNED as the expected string here —
     * the test asserted the bug rather than catching it. `calendarProviderLabel` now
     * composes the trailing noun itself, so no call site appends a second one.
     */
    it('degrades an unrecognised or absent provider to the generic noun, with no doubled "calendar"', () => {
      const result = getInAppTemplate('calendar-reconnect-required', {});
      expect(result.body).toContain('your calendar —');
      expect(result.body).not.toMatch(/calendar\s+calendar/i);
    });
  });

  describe('unknown template', () => {
    it('returns generic fallback for unknown template name', () => {
      const result = getInAppTemplate('nonexistent', {});
      expect(result).toEqual({
        title: 'Notification',
        body: 'You have a new notification',
      });
    });
  });
});
