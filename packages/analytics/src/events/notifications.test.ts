import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_SERVER_EVENTS,
  REMINDER_SERVER_EVENTS,
  type NotificationEventMap,
} from './notifications';

describe('NotificationEventMap[TOAST_SHOWN]', () => {
  type ToastShown = NotificationEventMap[typeof NOTIFICATION_EVENTS.TOAST_SHOWN];
  type LiveToast = Extract<ToastShown, { trigger: 'live' }>;

  it('accepts a load toast with no transport or latency', () => {
    expectTypeOf<{ count: number; trigger: 'load' }>().toExtend<ToastShown>();
  });

  it('accepts a live toast carrying its transport and latency', () => {
    expectTypeOf<{
      count: number;
      trigger: 'live';
      transport: 'push';
      latency_ms: number;
    }>().toExtend<ToastShown>();
    expectTypeOf<{
      count: number;
      trigger: 'live';
      transport: 'poll';
      latency_ms: number;
    }>().toExtend<ToastShown>();
    expectTypeOf<{
      count: number;
      trigger: 'live';
      transport: 'catch_up';
      latency_ms: number;
    }>().toExtend<ToastShown>();
  });

  it('rejects a live toast without a transport and latency', () => {
    expectTypeOf<{ count: number; trigger: 'live' }>().not.toExtend<ToastShown>();
  });

  it('declares no transport or latency on the load arm', () => {
    expectTypeOf<keyof Extract<ToastShown, { trigger: 'load' }>>().toEqualTypeOf<
      'count' | 'trigger'
    >();
  });

  it('types the live arm transport and latency', () => {
    expectTypeOf<LiveToast['transport']>().toEqualTypeOf<'push' | 'poll' | 'catch_up'>();
    expectTypeOf<LiveToast['latency_ms']>().toEqualTypeOf<number>();
  });
});

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

describe('REMINDER_SERVER_EVENTS', () => {
  it('exposes exactly the expected keys', () => {
    expect(Object.keys(REMINDER_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'SENT',
      'SKIPPED',
    ]);
  });

  it('maps each constant to its exact value', () => {
    expect(REMINDER_SERVER_EVENTS.SENT).toBe('reminder_sent');
    expect(REMINDER_SERVER_EVENTS.SKIPPED).toBe('reminder_skipped');
  });

  it('values follow the reminder_ prefix convention', () => {
    for (const value of Object.values(REMINDER_SERVER_EVENTS)) {
      expect(value).toMatch(/^reminder_[a-z]+$/);
    }
  });
});
