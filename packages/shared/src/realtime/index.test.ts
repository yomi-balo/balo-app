import { describe, expect, it } from 'vitest';
import { NOTIFICATIONS_EVENT_CREATED, notificationsChannelName } from './index';

describe('notificationsChannelName', () => {
  it('names the channel notifications:{userId}', () => {
    expect(notificationsChannelName('u1')).toBe('notifications:u1');
  });

  it('keeps distinct users on distinct channels', () => {
    expect(notificationsChannelName('u1')).not.toBe(notificationsChannelName('u2'));
  });
});

describe('NOTIFICATIONS_EVENT_CREATED', () => {
  it('is the notification.created wire name', () => {
    expect(NOTIFICATIONS_EVENT_CREATED).toBe('notification.created');
  });
});
