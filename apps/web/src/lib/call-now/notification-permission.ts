/**
 * Asks for browser notification permission the first time someone uses Call now, so a ring that
 * reaches them in a background tab can surface. Fire-and-forget: the call never waits on the
 * prompt, and a refusal or an unsupported browser changes nothing.
 */
export function requestCallNotificationPermission(): void {
  try {
    if (!('Notification' in globalThis)) return;
    if (globalThis.Notification.permission !== 'default') return;
    globalThis.Notification.requestPermission().catch(() => undefined);
  } catch {
    // Some browsers throw instead of rejecting: nothing to do.
  }
}
