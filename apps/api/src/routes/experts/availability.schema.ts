import { z } from 'zod';
import {
  AVAILABILITY_SCOPES,
  DEFAULT_AVAILABILITY_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
} from '@balo/shared/availability';

export const availabilityParamsSchema = z.object({
  expertProfileId: z.string().uuid(),
});

export type AvailabilityParams = z.infer<typeof availabilityParamsSchema>;

export const availabilityQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    // ⚠ REJECTS above the bound, never silently clamps (D6) — a caller asking for 30 days must
    // learn it cannot have them rather than receive 14 labelled as 30. Callers that want a
    // clamp do it on their own side; `ExpertAvailabilityCalendar` does.
    .max(MAX_AVAILABILITY_WINDOW_DAYS)
    .default(DEFAULT_AVAILABILITY_WINDOW_DAYS),
  // `new_work` is the fail-safe default: a caller that omits the scope never receives the grid
  // of an expert who has paused new work.
  scope: z.enum(AVAILABILITY_SCOPES).default('new_work'),
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
