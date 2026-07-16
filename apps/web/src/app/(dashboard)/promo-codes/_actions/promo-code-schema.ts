import { z } from 'zod';

/**
 * Shared Zod schemas + bounds for the promo-code Server Actions (BAL-384). Bounds are
 * shared with the DB CHECKs so the dialog's client parse, this Zod layer, and the DB
 * can never drift (mirrors `proposal-schema.ts` / the `override-balo-fee` MIN/MAX
 * pattern). Money is AUD integer minor units — the mint dialog converts the admin's
 * dollar entry to `grantMinor` (via `dollarsToMinor`) BEFORE calling the action, so the
 * schema always validates the minor-unit integer.
 */

/** grant_minor > 0 (DB CHECK `promo_codes_grant_positive`). */
export const MIN_GRANT_MINOR = 1;
/** Product-tunable sanity ceiling, well under the `integer` column's ~$21M cap. */
export const MAX_GRANT_MINOR = 2_000_000_00 - 1;
/** per_code_redemption_cap > 0 (DB CHECK `promo_codes_cap_positive`). */
export const MIN_CAP = 1;
/** Product-tunable sanity ceiling on total redemptions. */
export const MAX_CAP = 1_000_000;

/**
 * The normalized (uppercase) code shape: 3–32 chars, starting alphanumeric, then
 * alphanumeric or hyphen. Applied against the UPPERCASED value so a lowercase entry
 * (which the repo normalizes on write) still validates. Also used by the mint dialog for
 * inline format feedback. Bounded quantifier — no ReDoS (SonarCloud S5852).
 */
export const PROMO_CODE_REGEX = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export const createPromoCodeSchema = z
  .object({
    // The repo normalizes to uppercase before uniqueness applies; we validate the
    // normalized shape here so a malformed code is rejected regardless of entry case.
    code: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .refine((value) => PROMO_CODE_REGEX.test(value.toUpperCase()), {
        message: 'Use 3–32 letters, numbers, or hyphens.',
      }),
    grantMinor: z.number().int().min(MIN_GRANT_MINOR).max(MAX_GRANT_MINOR),
    perCodeRedemptionCap: z.number().int().min(MIN_CAP).max(MAX_CAP),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
  })
  .refine((v) => v.validUntil > v.validFrom, {
    path: ['validUntil'],
    message: 'End must be after start',
  });

export type CreatePromoCodeSchemaInput = z.infer<typeof createPromoCodeSchema>;

export const deactivatePromoCodeSchema = z.object({ id: z.uuid() });

export const updatePromoCapSchema = z.object({
  id: z.uuid(),
  newCap: z.number().int().min(MIN_CAP).max(MAX_CAP),
});
