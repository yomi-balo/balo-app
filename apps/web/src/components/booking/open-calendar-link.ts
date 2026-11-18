/**
 * Opens a pre-filled calendar "create event" link in a new tab, from a BUTTON — never an
 * `<a href>`. The link carries the call's title, description and (for a member) the call URL, and
 * PostHog autocapture records an anchor's href on click (`$external_click_url`,
 * `$elements_chain`), which `sanitizeAnalyticsEvent` does not reach. With no href in the DOM there
 * is nothing to capture; `calendar_add_option_clicked` records the choice instead.
 */
export function openCalendarLink(url: string): void {
  globalThis.open(url, '_blank', 'noopener,noreferrer');
}
