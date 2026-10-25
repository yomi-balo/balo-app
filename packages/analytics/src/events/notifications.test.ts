import { describe, it, expect } from 'vitest';
import { NOTIFICATION_EVENTS, NOTIFICATION_SERVER_EVENTS } from './notifications';

describe('NOTIFICATION_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(NOTIFICATION_EVENTS)).toEqual([
      'TOAST_SHOWN',
      'TOAST_DISMISSED',
      'PANEL_OPENED',
      'CLICKED',
      'AUTO_READ',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(NOTIFICATION_EVENTS.TOAST_SHOWN).toBe('notification_toast_shown');
    expect(NOTIFICATION_EVENTS.TOAST_DISMISSED).toBe('notification_toast_dismissed');
    expect(NOTIFICATION_EVENTS.PANEL_OPENED).toBe('notification_panel_opened');
    expect(NOTIFICATION_EVENTS.CLICKED).toBe('notification_clicked');
    expect(NOTIFICATION_EVENTS.AUTO_READ).toBe('notification_auto_read');
  });

  it('values follow the notification_ prefix convention', () => {
    for (const value of Object.values(NOTIFICATION_EVENTS)) {
      expect(value).toMatch(/^notification_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('NOTIFICATION_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(NOTIFICATION_SERVER_EVENTS)).toEqual([
      'SMS_SENT',
      'SMS_FAILED',
      'SMS_SKIPPED',
      'IN_APP_SENT',
      'IN_APP_FAILED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(NOTIFICATION_SERVER_EVENTS.SMS_SENT).toBe('notification_sms_sent');
    expect(NOTIFICATION_SERVER_EVENTS.SMS_FAILED).toBe('notification_sms_failed');
    expect(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED).toBe('notification_sms_skipped');
    expect(NOTIFICATION_SERVER_EVENTS.IN_APP_SENT).toBe('notification_in_app_sent');
    expect(NOTIFICATION_SERVER_EVENTS.IN_APP_FAILED).toBe('notification_in_app_failed');
  });

  it('values follow the notification_ prefix convention', () => {
    for (const value of Object.values(NOTIFICATION_SERVER_EVENTS)) {
      expect(value).toMatch(/^notification_[a-z]+(_[a-z]+)*$/);
    }
  });
});
