import { pgTable, uuid, text, numeric, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fxDisplayQuoteEnum } from './enums';
import { timestamps } from './helpers';

/**
 * fx_display_rates (BAL-376 / ADR-1040) — presentation-only FX quotes (AUD → GBP/EUR/
 * USD). NEVER referenced by any balance/settlement path (invariant #8): `rate` is a
 * NUMERIC surfaced as a string in JS and never enters balance math.
 *
 * NO `deletedAt` (deliberate): a replaceable display cache, last-write-wins per quote —
 * mirroring `company_billing_details`' "single current fact, no soft-delete". The
 * `(base, quote)` unique index is the onConflict target for the upsert; non-partial is
 * fine BECAUSE there is no soft-delete to interact with.
 */
export const fxDisplayRates = pgTable(
  'fx_display_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Always 'AUD' (CHECK below). The subsystem quotes AUD → foreign for display only.
    base: text('base').notNull().default('AUD'),

    quote: fxDisplayQuoteEnum('quote').notNull(),

    // Display rate — NUMERIC(18,8), a string in JS (never math).
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),

    // Source timestamp of the quote.
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('fx_display_rates_base_quote_idx').on(t.base, t.quote),
    check('fx_display_rates_base_aud', sql`${t.base} = 'AUD'`),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type FxDisplayRate = typeof fxDisplayRates.$inferSelect;
export type NewFxDisplayRate = typeof fxDisplayRates.$inferInsert;

/** FX display-quote currency (schema-derived — single source of truth). */
export type FxDisplayQuote = (typeof fxDisplayQuoteEnum.enumValues)[number];
