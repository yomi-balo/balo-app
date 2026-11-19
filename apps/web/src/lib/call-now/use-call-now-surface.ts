'use client';

import type { CallNowSurface } from '@balo/analytics/events';
import { useIsMobile } from '@/hooks/use-mobile';

/** The breakpoint below which the confirm opens as a bottom sheet rather than a dialog. */
export const CALL_NOW_MOBILE_BREAKPOINT = 768;

/**
 * Where the Call now surface is rendered, for the `surface` property on its events. One definition,
 * so the dialog's layout choice and the analytics can never disagree about what "mobile" means.
 */
export function useCallNowSurface(): CallNowSurface {
  return useIsMobile(CALL_NOW_MOBILE_BREAKPOINT) ? 'mobile' : 'desktop';
}
