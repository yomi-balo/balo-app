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
