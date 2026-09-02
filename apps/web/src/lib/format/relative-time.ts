/**
 * Compact relative timestamps for file rows ("just now", "3h ago", "2d ago", "3w ago").
 *
 * ⚠ RELOCATED BY BAL-431 (OSD-2), NOT NEW. It lived in
 * `components/balo/conversation/thread-files-panel.tsx` — the in-thread files drawer — until
 * that drawer was retired from the request surface. The formatter itself outlived the panel
 * because the REPLACEMENT surface (`components/balo/project-request/files/request-file-row.tsx`,
 * the request-level file home) renders the same "uploader · relative time · size" subline, so
 * deleting the panel's module would have taken a live dependency with it. It is a pure string
 * function with no conversation/relationship shape in it at all, so `lib/format/` — beside
 * `local-date` and `utc-date` — is where it belongs rather than under any one surface's
 * component tree.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact relative timestamp for file rows ("just now", "3h ago", "2d ago"). */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
