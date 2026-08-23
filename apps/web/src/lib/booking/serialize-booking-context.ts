import 'server-only';

import type { BookingContext as ServerBookingContext } from './load-booking-context';
import type { BookingContext as ClientBookingContext } from '@/components/booking/types';

/**
 * BAL-400 — the RSC boundary conversion for `loadBookingContext`'s result. The shipped
 * (slice 2) `BookingContext` types `openCases[].lastActivityAt`/`createdAt` as `Date` (a
 * repository-shaped return value); this codebase's convention is that a view-model crossing
 * server→client is fully pre-formatted (`case-view-types.ts`'s "no Date objects" rule), so this
 * function is the one place that boundary is crossed for the booking flow. It also drops the
 * arm-carried `expert` field — the wrapper always receives expert display data via its own
 * `BookingFlowExpert` prop (built from data every entry point already has), which covers the
 * two failure arms `BookingContext` itself cannot carry an `expert` on.
 */
export function serializeBookingContext(context: ServerBookingContext): ClientBookingContext {
  if (context.arm === 'onboarding_required' || context.arm === 'company_read_failed') {
    return { arm: context.arm };
  }
  if (context.arm === 'choose_company') {
    return { arm: 'choose_company', companies: context.companies };
  }
  return {
    arm: 'single_company',
    company: context.company,
    resolvedCaseCount: context.resolvedCaseCount,
    openCases: context.openCases.map((c) => ({
      engagementId: c.engagementId,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      lastActivityAt: c.lastActivityAt.toISOString(),
      consultationCount: c.consultationCount,
    })),
  };
}
