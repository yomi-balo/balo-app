/**
 * Asks for browser notification permission the first time someone uses Call now, so a ring that
 * reaches them in a background tab can surface. Fire-and-forget: the call never waits on the
 * prompt, and a refusal or an unsupported browser changes nothing.
 */
export function requestCallNotificationPermission(): void {
  if (!('Notification' in globalThis)) return;
  if (globalThis.Notification.permission !== 'default') return;
  askPermission().catch(() => undefined);
}

/**
 * `requestPermission()` runs before the first `await`, so it is still inside the click. A
 * synchronous throw, a rejection and an older browser's `undefined` return all end here.
 */
async function askPermission(): Promise<void> {
  try {
    await globalThis.Notification.requestPermission();
  } catch {
    // Refused or unsupported: nothing to do.
  }
}
