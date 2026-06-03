/**
 * Pure URL-state contract for Expert Search (`/experts`).
 *
 * This is the single source of truth for parsing/serialising filter state to and
 * from the URL. It is shared with the future search-composer ticket. No React, no
 * fetch — only pure functions so it is trivially unit-testable.
 *
 * Conventions (resolved in the technical plan):
 * - The URL carries facet IDs (UUIDs), not labels — the rail sources options from
 *   `facetCounts`, so the request mapper is a pass-through.
 * - Rate is stored in the URL as A$ dollars (the rail's input unit) and converted
 *   to per-minute cents only at the API boundary (`filtersToSearchRequest`).
 * - `vertical` defaults to `'salesforce'` and is omitted from the URL unless changed.
 * - Invalid `sort` / `timeframe` / `page` / rate values are clamped to defaults on
 *   parse (the URL is user-editable).
 */

export const SORT_VALUES = ['best_match', 'soonest', 'lowest_rate', 'most_experienced'] as const;
export type SortValue = (typeof SORT_VALUES)[number];

export const TIMEFRAME_VALUES = ['today', '3days', 'week'] as const;
export type TimeframeValue = (typeof TIMEFRAME_VALUES)[number];

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_VERTICAL = 'salesforce';
export const DEFAULT_SORT: SortValue = 'best_match';

/** Array filter groups, keyed by their URL param name. */
const ARRAY_KEYS = ['products', 'supportTypes', 'languages'] as const;
type ArrayKey = (typeof ARRAY_KEYS)[number];

export interface SearchFilters {
  /** Free-text query; `''` when absent. */
  q: string;
  /** Skill UUIDs (facetCounts.products[].id). */
  products: string[];
  /** Support-type UUIDs. */
  supportTypes: string[];
  /** Language UUIDs. */
  languages: string[];
  /** Availability window; `null` when unset. */
  timeframe: TimeframeValue | null;
  /** A$ per-minute lower bound (UI unit); `null` when unset. */
  rateMinDollars: number | null;
  /** A$ per-minute upper bound (UI unit); `null` when unset. */
  rateMaxDollars: number | null;
  /** Vertical slug; default `'salesforce'`. */
  vertical: string;
  /** Sort key; default `'best_match'`. */
  sort: SortValue;
  /** 1-based page; default `1`. */
  page: number;
}

export const EMPTY_FILTERS: SearchFilters = {
  q: '',
  products: [],
  supportTypes: [],
  languages: [],
  timeframe: null,
  rateMinDollars: null,
  rateMaxDollars: null,
  vertical: DEFAULT_VERTICAL,
  sort: DEFAULT_SORT,
  page: 1,
};

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function getAll(params: RawParams, key: string): string[] {
  if (params instanceof URLSearchParams) {
    return params.getAll(key);
  }
  const value = params[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function getOne(params: RawParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) {
    return params.get(key) ?? undefined;
  }
  const value = params[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isSortValue(value: string | undefined): value is SortValue {
  return value !== undefined && (SORT_VALUES as readonly string[]).includes(value);
}

function isTimeframeValue(value: string | undefined): value is TimeframeValue {
  return value !== undefined && (TIMEFRAME_VALUES as readonly string[]).includes(value);
}

/** Parse a positive number from a raw param; returns `null` if invalid/non-positive. */
function parsePositiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Parse the 1-based page param; clamps to `1` on anything invalid. */
function parsePage(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

export function parseSearchParams(params: RawParams): SearchFilters {
  const vertical = getOne(params, 'vertical');
  const sort = getOne(params, 'sort');
  const timeframe = getOne(params, 'timeframe');

  return {
    q: getOne(params, 'q') ?? '',
    products: getAll(params, 'products'),
    supportTypes: getAll(params, 'supportTypes'),
    languages: getAll(params, 'languages'),
    timeframe: isTimeframeValue(timeframe) ? timeframe : null,
    rateMinDollars: parsePositiveNumber(getOne(params, 'rateMin')),
    rateMaxDollars: parsePositiveNumber(getOne(params, 'rateMax')),
    vertical: vertical && vertical.trim() !== '' ? vertical : DEFAULT_VERTICAL,
    sort: isSortValue(sort) ? sort : DEFAULT_SORT,
    page: parsePage(getOne(params, 'page')),
  };
}

/**
 * Serialise filters back to URL params, omitting defaults and empty values so the
 * URL stays clean (and `parse(serialize(x)) === x`).
 */
export function serializeSearchFilters(filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.q.trim() !== '') params.set('q', filters.q);

  for (const key of ARRAY_KEYS) {
    for (const id of filters[key as ArrayKey]) {
      params.append(key, id);
    }
  }

  if (filters.timeframe) params.set('timeframe', filters.timeframe);
  if (filters.rateMinDollars != null) params.set('rateMin', String(filters.rateMinDollars));
  if (filters.rateMaxDollars != null) params.set('rateMax', String(filters.rateMaxDollars));
  if (filters.vertical !== DEFAULT_VERTICAL) params.set('vertical', filters.vertical);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));

  return params;
}

export interface SearchRequest {
  q?: string;
  products: string[];
  supportTypes: string[];
  languages: string[];
  timeframe?: TimeframeValue;
  /** Per-minute cents (int). */
  rateMin?: number;
  /** Per-minute cents (int). */
  rateMax?: number;
  vertical: string;
  sort: SortValue;
  page: number;
  pageSize: number;
}

/** A$ dollars → per-minute cents (the API unit). */
function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Map filters to the API request shape. Facet IDs pass straight through; rate is
 * converted A$ → cents here, the only place that conversion happens.
 */
export function filtersToSearchRequest(filters: SearchFilters): SearchRequest {
  const request: SearchRequest = {
    products: filters.products,
    supportTypes: filters.supportTypes,
    languages: filters.languages,
    vertical: filters.vertical,
    sort: filters.sort,
    page: filters.page,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  if (filters.q.trim() !== '') request.q = filters.q;
  if (filters.timeframe) request.timeframe = filters.timeframe;
  if (filters.rateMinDollars != null) request.rateMin = dollarsToCents(filters.rateMinDollars);
  if (filters.rateMaxDollars != null) request.rateMax = dollarsToCents(filters.rateMaxDollars);

  return request;
}

/**
 * Count active filters for the mobile "Filters (N)" badge. Each non-empty facet
 * group, the timeframe, each rate bound, and a non-empty query count as one.
 */
export function countActiveFilters(filters: SearchFilters): number {
  let count = 0;
  if (filters.q.trim() !== '') count += 1;
  if (filters.products.length > 0) count += 1;
  if (filters.supportTypes.length > 0) count += 1;
  if (filters.languages.length > 0) count += 1;
  if (filters.timeframe) count += 1;
  if (filters.rateMinDollars != null) count += 1;
  if (filters.rateMaxDollars != null) count += 1;
  return count;
}
