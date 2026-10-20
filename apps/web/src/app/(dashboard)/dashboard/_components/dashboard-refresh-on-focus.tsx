'use client';

import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

/**
 * Refreshes the dashboard's server data when the tab regains focus. Mounted once per dashboard so
 * the Your move and Up next cards share a single listener instead of each owning one.
 */
export function DashboardRefreshOnFocus(): null {
  useRefreshOnFocus();
  return null;
}
