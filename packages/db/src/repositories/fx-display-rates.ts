import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { fxDisplayRates, type FxDisplayQuote, type FxDisplayRate } from '../schema';

export const fxDisplayRatesRepository = {
  /**
   * Upsert the single current display rate for a `(base, quote)` pair (base defaults to
   * 'AUD'). Last-write-wins via `onConflictDoUpdate` on `fx_display_rates_base_quote_idx`.
   * `rate` is a NUMERIC string (never math). Presentation-only — NEVER a balance figure.
   */
  async upsert(input: {
    quote: FxDisplayQuote;
    rate: string;
    asOf: Date;
    base?: string;
  }): Promise<FxDisplayRate> {
    const base = input.base ?? 'AUD';
    const [row] = await db
      .insert(fxDisplayRates)
      .values({ base, quote: input.quote, rate: input.rate, asOf: input.asOf })
      .onConflictDoUpdate({
        target: [fxDisplayRates.base, fxDisplayRates.quote],
        set: { rate: input.rate, asOf: input.asOf, updatedAt: new Date() },
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to upsert fx display rate');
    }
    return row;
  },

  /** The current AUD→quote display rate, if present. */
  async getLatest(quote: FxDisplayQuote): Promise<FxDisplayRate | undefined> {
    return db.query.fxDisplayRates.findFirst({
      where: and(eq(fxDisplayRates.base, 'AUD'), eq(fxDisplayRates.quote, quote)),
    });
  },

  /** Every current AUD→* display rate, ordered by quote. */
  async listLatest(): Promise<FxDisplayRate[]> {
    return db
      .select()
      .from(fxDisplayRates)
      .where(eq(fxDisplayRates.base, 'AUD'))
      .orderBy(asc(fxDisplayRates.quote));
  },
};
