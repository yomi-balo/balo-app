/**
 * BAL-468 §9.1 — the single declaration of the Apiroc webhook URL shape, imported by BOTH
 * the route (for its declared path) and the reconciler (for the URL it registers at the
 * vendor) so the two can never drift.
 *
 * The webhook URL keys on Balo's OWN subscription row id, never a vendor id (apiroc skill
 * webhooks-and-events.md, A2). One indexed read; nothing to URL-encode; leaks nothing.
 *
 * PURE — no I/O beyond reading `process.env.APIROC_WEBHOOK_BASE_URL`. Provider-agnostic by
 * construction: this module never receives or names a provider (Scan B, `invariants/`).
 */

export const APIROC_WEBHOOK_PATH_PREFIX = '/webhooks/apiroc/calendar/';
export const APIROC_WEBHOOK_ROUTE_PATH = `${APIROC_WEBHOOK_PATH_PREFIX}:calendarSubscriptionId`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The HTTPS origin webhooks are registered against, with any trailing slash removed — or
 * `null` when unset or not `https://`. This is the feature's on-switch (BAL-468 plan §17):
 * both the reconciler's guard 2 and the monitor's arm-3 gate read this function, never the
 * raw env var, so there is exactly one place the on/off decision is made.
 */
export function resolveWebhookBaseUrl(): string | null {
  const raw = process.env.APIROC_WEBHOOK_BASE_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('https://')) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * `${base}/webhooks/apiroc/calendar/${rowId}` — the exact URL registered at the vendor for
 * one subscription row. Throws when the base is unconfigured; callers should have already
 * checked `resolveWebhookBaseUrl() !== null` (the reconciler's guard 2) before minting a row
 * id at all.
 */
export function buildSubscriptionWebhookUrl(rowId: string): string {
  const base = resolveWebhookBaseUrl();
  if (base === null) {
    throw new Error('APIROC_WEBHOOK_BASE_URL is not configured');
  }
  return `${base}${APIROC_WEBHOOK_PATH_PREFIX}${rowId}`;
}

/**
 * Extracts Balo's row id from a vendor-echoed webhook URL, given the exact prefix this
 * connection's subscriptions were registered under (`${base}${APIROC_WEBHOOK_PATH_PREFIX}`).
 * `null` for a foreign prefix or a non-uuid tail — both cases the orphan rule and the route
 * must treat as "not one of ours" / "not a well-formed id", never as a partial match.
 */
export function subscriptionRowIdFromWebhookUrl(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix)) return null;
  const tail = url.slice(prefix.length);
  return UUID_PATTERN.test(tail) ? tail : null;
}
