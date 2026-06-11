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
