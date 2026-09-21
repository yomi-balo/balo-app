import { z } from 'zod';
import { SLOT_DURATION_LADDER } from '@balo/shared/availability';

/**
 * Milliseconds per minute — shared by the slot-window cross-check below AND both callers' own
 * `windowMinutes` derivation (the duration OF THE MEETING, computed from the server's returned
 * window). One definition so the two arithmetic sites can never disagree about the divisor.
 */
export const MS_PER_MINUTE = 60_000;

const slotDurations = SLOT_DURATION_LADDER as readonly number[];

/**
 * ⚠⚠ THE SLOT WINDOW MUST *AGREE* WITH `durationMinutes` (round-1 security MEDIUM, shipped
 * first in `book-intro-call.ts`). Extracted here in BAL-478 fix round 3 (external review of
 * PR #333, non-blocking finding) after the IDENTICAL check was duplicated verbatim into
 * `book-consultation.ts`'s schema (BAL-478 B1) — this is a SECURITY CHECK THAT MUST CHANGE IN
 * BOTH CALLERS AT ONCE, so a shared definition is the only way a future edit cannot silently
 * diverge and reopen the spoof on whichever caller lags.
 *
 * Before either fix existed, `durationMinutes` was validated against `SLOT_DURATION_LADDER` and
 * then NEVER CROSS-CHECKED against the raw window that actually crosses the wire and drives
 * scheduling (and, for `book-consultation.ts`, the funding gate's estimate).
 * `{durationMinutes: 15, slot: {09:00 → 17:00}}` consumed an expert's WHOLE published day as one
 * free consultation costing a single rate-limit unit (`book-intro-call.ts`'s original defect);
 * `{durationMinutes: 15, slot: {a 3-hour window}}` passed BAL-478's funding gate on a fraction
 * of the required balance, then booked the full window (`book-consultation.ts`'s B1 defect).
 *
 * ⚠ THIS IS NOT A BILLING FLOOR and it does not weaken either caller's own downstream window
 * bound (`apps/api`'s `validateBookingWindow`, or the funding gate's estimate). It only refuses
 * a client submission that contradicts ITSELF.
 *
 * ⚠ `.datetime()`, NOT `.min(1)` — an unparseable instant would make the subtraction `NaN`, and
 * `NaN !== anything` happens to be `true`, so the refinement would technically still reject it —
 * but as an unnamed arithmetic side effect rather than a named `invalid_request` at the
 * boundary.
 *
 * Both callers compose this as their `slot` field with `.strict()` object schemas of their own
 * — this schema is already `.strict()` on its own three fields, so nesting it costs nothing.
 * Neither caller's external behaviour (failure code, stage) changes: a mismatch still surfaces
 * as this schema's own `ZodIssueCode.custom` at `path: ['endIso']`, which each caller's
 * `safeParse(...).success === false` branch already maps to `invalid_request` at the validation
 * stage, before any write and before either caller's own extra checks run.
 */
export const bookingSlotSchema = z
  .object({
    startIso: z.string().datetime(),
    endIso: z.string().datetime(),
    durationMinutes: z
      .number()
      .refine((value) => slotDurations.includes(value), { message: 'invalid duration' }),
  })
  .strict()
  .superRefine((slot, ctx) => {
    const spanMs = Date.parse(slot.endIso) - Date.parse(slot.startIso);
    if (spanMs !== slot.durationMinutes * MS_PER_MINUTE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endIso'],
        message: 'slot window does not match durationMinutes',
      });
    }
  });

export type BookingSlot = z.infer<typeof bookingSlotSchema>;
