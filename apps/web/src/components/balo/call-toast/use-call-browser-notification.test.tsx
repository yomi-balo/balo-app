import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RingingToastView } from './call-toast-model';
import { useCallBrowserNotification } from './use-call-browser-notification';

const notifications = vi.hoisted(() => ({
  created: [] as { title: string; options: NotificationOptions; close: () => void }[],
  permission: 'granted' as NotificationPermission,
}));

class FakeNotification {
  static get permission(): NotificationPermission {
    return notifications.permission;
  }
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, options: NotificationOptions) {
    notifications.created.push({ title, options, close: this.close });
  }
}

const realNotification = globalThis.Notification;

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function ring(overrides: Partial<RingingToastView> = {}): RingingToastView {
  return {
    mode: 'ringing',
    ringId: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    lens: 'client',
    callerLabel: 'Sandy',
    caseTitle: 'Flow migration',
    rateLine: null,
    awaitsAnswer: true,
    joinPath: '/meetings/meeting-1/call',
    expiresAtIso: '2026-11-19T10:00:30.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  notifications.created.length = 0;
  notifications.permission = 'granted';
  globalThis.Notification = FakeNotification as unknown as typeof Notification;
  setVisibility('hidden');
});

afterEach(() => {
  globalThis.Notification = realNotification;
  setVisibility('visible');
});

describe('useCallBrowserNotification', () => {
  it('raises one per-ring-tagged notification in a hidden tab', () => {
    renderHook(() => useCallBrowserNotification(ring()));

    expect(notifications.created).toEqual([
      expect.objectContaining({
        title: 'Sandy is calling',
        options: { body: 'Flow migration. Open Balo to join.', tag: 'balo-call-ring-1' },
      }),
    ]);
  });

  it('stays quiet when the tab is in front', () => {
    setVisibility('visible');
    renderHook(() => useCallBrowserNotification(ring()));

    expect(notifications.created).toHaveLength(0);
  });

  it.each(['default', 'denied'] as const)('stays quiet when permission is %s', (permission) => {
    notifications.permission = permission;
    renderHook(() => useCallBrowserNotification(ring()));

    expect(notifications.created).toHaveLength(0);
  });

  it('raises it when the tab goes to the background mid-ring, once', () => {
    setVisibility('visible');
    renderHook(() => useCallBrowserNotification(ring()));
    setVisibility('hidden');

    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(notifications.created).toHaveLength(1);
  });

  it('closes it when the ring ends and when the toast unmounts', () => {
    const { rerender, unmount } = renderHook(
      ({ view }: { view: RingingToastView | null }) => useCallBrowserNotification(view),
      { initialProps: { view: ring() as RingingToastView | null } }
    );

    rerender({ view: null });
    expect(notifications.created[0]?.close).toHaveBeenCalledTimes(1);

    rerender({ view: ring({ ringId: 'ring-2' }) });
    unmount();
    expect(notifications.created[1]?.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing where the API is absent', () => {
    // @ts-expect-error simulating a browser without notifications
    delete globalThis.Notification;

    expect(() => renderHook(() => useCallBrowserNotification(ring()))).not.toThrow();
  });

  it('does nothing without a ring', () => {
    renderHook(() => useCallBrowserNotification(null));

    expect(notifications.created).toHaveLength(0);
  });
});
