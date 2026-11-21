'use client';

import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useRefreshOnMeetingsChanged } from '@/hooks/use-refresh-on-meetings-changed';

/**
 * Refreshes the dashboard's server data when the tab regains focus or the notification feed
 * reports a meeting change. Mounted once per dashboard so the Your move and Up next cards share a
 * single listener instead of each owning one.
 */
export function DashboardRefreshOnFocus(): null {
  useRefreshOnFocus();
  useRefreshOnMeetingsChanged();
  return null;
}
