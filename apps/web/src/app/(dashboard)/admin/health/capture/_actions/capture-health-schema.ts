import { z } from 'zod';
import { CAPTURE_HEALTH_CATEGORIES, REDRIVE_KINDS } from '@balo/shared/capture-health';

/**
 * BAL-550 — schemas for the capture-health Server Actions. A SIBLING FILE, not inlined in the
 * action modules — a `'use server'` module may export ONLY async functions (the
 * `admin-alert-schema.ts` shape, verbatim).
 */

const captureHealthCursorSchema = z.object({
  healthRank: z.number().int().min(0),
  scheduledStartIso: z.iso.datetime(),
  meetingId: z.uuid(),
});

/**
 * `YYYY-MM-DD`, the shape `parseCaptureHealthWindow` parses and the two `<input type="date">`s
 * emit. `z.iso.date()` accepts the same shape and ALSO rejects `2026-02-30`.
 *
 * ⚠ THIS IS A SHAPE CHECK, NOT THE WINDOW BOUND. The span itself is clamped by
 * `parseCaptureHealthWindow` inside the action — see its docblock. A bare `z.string()` here
 * used to let any two parseable instants through and the action then built the read window from
 * them by hand, re-opening an unbounded span over the three grouped aggregate sub-queries.
 */
const captureHealthDaySchema = z.iso.date();

export const loadMoreCaptureHealthSchema = z
  .object({
    cursor: captureHealthCursorSchema,
    fromIso: captureHealthDaySchema,
    toIso: captureHealthDaySchema,
    category: z.enum(CAPTURE_HEALTH_CATEGORIES).nullable(),
    withheldBeforeIso: z.iso.datetime(),
  })
  .strict();

export type LoadMoreCaptureHealthInput = z.infer<typeof loadMoreCaptureHealthSchema>;

export type LoadMoreCaptureHealthResult =
  | {
      success: true;
      rows: readonly import('../_lib/capture-health-view').CaptureHealthRowView[];
      hasMore: boolean;
      nextCursor: import('../_lib/load-capture-health').CaptureHealthCursorDTO | null;
    }
  | { success: false; error: string };

export const requestRedriveSchema = z
  .object({
    kind: z.enum(REDRIVE_KINDS),
    entityId: z.uuid(),
  })
  .strict();

export type RequestRedriveInput = z.infer<typeof requestRedriveSchema>;

export type RequestRedriveResult =
  | { success: true; jobId: string }
  | {
      success: false;
      reason: 'forbidden' | 'not_redrivable' | 'enqueue_failed' | 'unavailable' | 'invalid';
      error: string;
    };
