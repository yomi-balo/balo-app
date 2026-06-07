import { z } from 'zod';

/**
 * Fastify delivers a repeated querystring param (`?products=a&products=b`) as an
 * array and a single one (`?products=a`) as a string; `z.preprocess` coerces both
 * (and absence) to `string[]`. All facet filters are UUIDs for contract
 * uniformity — the BAL-247 filter rail sources IDs from the existing
 * `referenceDataRepository` endpoints.
 */
const toArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const uuidArray = z.preprocess(toArray, z.array(z.string().uuid())).default([]);

export const TIMEFRAME_VALUES = ['today', '3days', 'week'] as const;
export const SORT_VALUES = ['best_match', 'soonest', 'lowest_rate', 'most_experienced'] as const;

export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    products: uuidArray, // products.id[]
    supportTypes: uuidArray, // support_types.id[] (UUIDs — vertical-scoped, N types per vertical)
    languages: uuidArray, // languages.id[]
    industries: uuidArray, // industries.id[]
    vertical: z.string().trim().min(1).default('salesforce'), // SLUG → resolved to id; never hardcode UUID
    timeframe: z.enum(TIMEFRAME_VALUES).optional(),
    rateMin: z.coerce.number().int().min(0).optional(), // per-minute cents
    rateMax: z.coerce.number().int().min(0).optional(), // per-minute cents
    sort: z.enum(SORT_VALUES).default('best_match'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => v.rateMax === undefined || v.rateMin === undefined || v.rateMax >= v.rateMin, {
    message: 'rateMax must be >= rateMin',
    path: ['rateMax'],
  });

export type SearchQuery = z.infer<typeof searchQuerySchema>;
