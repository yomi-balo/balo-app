import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestCallNotificationPermission } from './notification-permission';

function stubNotification(permission: string, requestPermission: () => Promise<string>): void {
  vi.stubGlobal('Notification', { permission, requestPermission });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestCallNotificationPermission', () => {
  it('asks once when the permission is undecided', () => {
    const request = vi.fn().mockResolvedValue('granted');
    stubNotification('default', request);
    requestCallNotificationPermission();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['granted', 'denied'])('does not ask when it is already %s', (permission) => {
    const request = vi.fn().mockResolvedValue(permission);
    stubNotification(permission, request);
    requestCallNotificationPermission();
    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing without the Notification API', () => {
    vi.stubGlobal('Notification', undefined);
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(() => requestCallNotificationPermission()).not.toThrow();
  });

  it('swallows a rejected or throwing request', () => {
    stubNotification('default', () => Promise.reject(new Error('no')));
    expect(() => requestCallNotificationPermission()).not.toThrow();
    stubNotification('default', () => {
      throw new Error('sync');
    });
    expect(() => requestCallNotificationPermission()).not.toThrow();
  });
});
