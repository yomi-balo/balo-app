'use client';

import { useEffect } from 'react';
import { analytics } from '@/lib/analytics';
import type { AnalyticsIdentifyProps } from '@/lib/auth/impersonation';

/**
 * BAL-504 — the identify effect for every placement that already has `user` in hand
 * (`analyticsIdentifyPropsFor` in `@/lib/auth/impersonation`). The root layout itself never
 * reads the session, so this component is mounted directly by each placement instead.
 *
 * ⚠ THE IMPORT ABOVE IS TYPE-ONLY. `@/lib/auth/impersonation` starts with `import 'server-only'`,
 * so a VALUE import here would pull that guard (and the Node-only logger it drags in) into this
 * client bundle. A type-only import erases at compile time and costs nothing at runtime.
 *
 * Renders nothing. `userId`/`userTraitsJson` absent (either one) is a no-op.
 */
export function AnalyticsIdentify({
  userId,
  userTraitsJson,
}: Readonly<AnalyticsIdentifyProps>): null {
  useEffect(() => {
    if (userId && userTraitsJson) {
      analytics.identify(userId, JSON.parse(userTraitsJson) as Record<string, unknown>);
    }
  }, [userId, userTraitsJson]);

  return null;
}
