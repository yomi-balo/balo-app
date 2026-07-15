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

  describe('project-message-posted', () => {
    it('renders sender + preview with the request action url', () => {
      const result = getInAppTemplate('project-message-posted', {
        senderName: 'Priya Nair',
        preview: 'Quick question about the CPQ scope',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'New message',
        body: 'Priya Nair: Quick question about the CPQ scope',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-message-posted', {});
      expect(result.body).toBe('Someone: sent you a message');
      expect(result.actionUrl).toBeUndefined();
    });
  });

  describe('project-file-shared', () => {
    it('renders sender + file name with the request action url', () => {
      const result = getInAppTemplate('project-file-shared', {
        senderName: 'Dana Whitfield',
        fileName: 'price-book-export.xlsx',
        projectRequestId: 'req-1',
      });
      expect(result).toEqual({
        title: 'New file shared',
        body: 'Dana Whitfield shared price-book-export.xlsx',
        actionUrl: '/projects/req-1',
      });
    });

    it('falls back when fields are missing and omits the url without an id', () => {
      const result = getInAppTemplate('project-file-shared', {});
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
