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
