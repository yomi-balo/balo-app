/**
 * Opens a pre-filled calendar "create event" link in a new tab, from a BUTTON — never an
 * `<a href>`. The link carries the call's title, description and (for a member) the call URL, and
 * PostHog autocapture records an anchor's href on click (`$external_click_url`,
 * `$elements_chain`), which `sanitizeAnalyticsEvent` does not reach. With no href in the DOM there
 * is nothing to capture; `calendar_add_option_clicked` records the choice instead.
 *
 * ⚠ NO `noopener` FEATURE STRING: with it `open()` always returns `null`, so a blocked popup (some
 * mail apps' in-app browsers) would be indistinguishable from success and the click would do
 * nothing. Instead the opener is cut by hand, and a blocked popup falls back to navigating this
 * tab. Referrer: the add-to-calendar page sets `no-referrer`; elsewhere the site policy applies.
 */
export function openCalendarLink(url: string): void {
  const opened = globalThis.open(url, '_blank');
  if (opened === null) {
    globalThis.location.assign(url);
    return;
  }
  opened.opener = null;
}
