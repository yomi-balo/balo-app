'use client';

import { useEffect } from 'react';
import { track, BILLING_EVENTS } from '@/lib/analytics';

interface BillingBlockedViewTrackerProps {
  companyId: string;
  requestId: string;
}

/**
 * Fires `billing_details_blocked_view` exactly once when a client-lens MEMBER (not
 * owner/admin) views the billing capture step and sees the notice. Rendered by the
 * request-detail shell (which mounts once per page) rather than the KickoffBoard
 * (which mounts twice per client — desktop column + mobile sheet — and would
 * over-count). Renders nothing.
 */
export function BillingBlockedViewTracker({
  companyId,
  requestId,
}: Readonly<BillingBlockedViewTrackerProps>): null {
  useEffect(() => {
    track(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, { company_id: companyId, request_id: requestId });
  }, [companyId, requestId]);

  return null;
}
