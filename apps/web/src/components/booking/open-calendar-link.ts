/**
 * Opening a pre-filled calendar "create event" link — always from a BUTTON, never an `<a href>`.
 * The link carries the call's title, description and (for a member) the call URL, and PostHog
 * autocapture records an anchor's href on click (`$external_click_url`, `$elements_chain`), which
 * `sanitizeAnalyticsEvent` does not reach. With no href in the DOM there is nothing to capture;
 * `calendar_add_option_clicked` records the choice instead.
 *
 * Two surfaces, two behaviours — chosen so that NEITHER depends on a popup's return value, which
 * in-app mail browsers report unreliably (a blocked popup and one handed to the system browser
 * can both return `null`):
 *   · {@link navigateToCalendarLink} — the add-to-calendar page exists only for this step, so it
 *     navigates the same tab: nothing to block, nothing to open twice, and Back returns to it.
 *   · {@link openCalendarLinkInNewTab} — the booking confirmation keeps the client in Balo. On a
 *     blocked tab it reports `false` (the caller says so) rather than navigating away.
 */

export function navigateToCalendarLink(url: string): void {
  globalThis.location.assign(url);
}

/**
 * `true` when a tab opened. ⚠ No `noopener` feature string: with it `open()` ALWAYS returns
 * `null`, so a blocked tab could not be told apart. The opener is cut by hand instead.
 */
export function openCalendarLinkInNewTab(url: string): boolean {
  const opened = globalThis.open(url, '_blank');
  if (opened === null) return false;
  opened.opener = null;
  return true;
}
