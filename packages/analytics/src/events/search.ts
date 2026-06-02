/**
 * Client-side (browser) search events. These complement the server-emitted
 * `search_performed` / `search_zero_results` with UI context (position, layout,
 * pagination) that only the page can observe. Do NOT duplicate the server events.
 */
export const SEARCH_EVENTS = {
  RESULT_CLICKED: 'search_result_clicked',
  ZERO_RESULTS_VIEWED: 'search_zero_results_viewed',
  LAYOUT_TOGGLED: 'search_layout_toggled',
  FILTERS_OPENED: 'search_filters_opened',
  PAGINATION: 'search_pagination',
} as const;

export interface SearchEventMap {
  [SEARCH_EVENTS.RESULT_CLICKED]: {
    expert_id: string;
    position: number;
    sort: string;
    page: number;
  };
  [SEARCH_EVENTS.ZERO_RESULTS_VIEWED]: {
    filters: Record<string, unknown>;
    was_availability_gated: boolean;
  };
  [SEARCH_EVENTS.LAYOUT_TOGGLED]: { to: 'grid' | 'list' };
  [SEARCH_EVENTS.FILTERS_OPENED]: Record<string, never>;
  [SEARCH_EVENTS.PAGINATION]: { to_page: number };
}

export const SEARCH_SERVER_EVENTS = {
  SEARCH_PERFORMED: 'search_performed',
  SEARCH_ZERO_RESULTS: 'search_zero_results',
} as const;

export interface SearchServerEventMap {
  [SEARCH_SERVER_EVENTS.SEARCH_PERFORMED]: {
    has_query: boolean;
    filter_count: number;
    result_count: number;
    sort: string;
    vertical: string;
    distinct_id: string;
  };
  [SEARCH_SERVER_EVENTS.SEARCH_ZERO_RESULTS]: {
    query: string;
    filters: Record<string, unknown>;
    distinct_id: string;
  };
}
