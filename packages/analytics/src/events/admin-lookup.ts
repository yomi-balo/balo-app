import type { LookupEntityType, LookupTypeFilter } from '@balo/shared/lookup';

/**
 * BAL-551 — the admin Lookup surface's CLIENT event family (one search box across entity
 * types). Both events are browser-emitted; there is no server family.
 */
export const ADMIN_LOOKUP_EVENTS = {
  SEARCHED: 'admin_lookup_searched',
  OPENED: 'admin_lookup_opened',
} as const;

/**
 * How the QUERY looked, not which column matched — a shape heuristic over the input, computed
 * by `classifyLookupQuery` (apps/web). Its docblock says so; do not read this as match
 * provenance.
 */
export type AdminLookupMatchedBy = 'name' | 'email' | 'id';

export interface AdminLookupEventMap {
  [ADMIN_LOOKUP_EVENTS.SEARCHED]: {
    result_count: number;
    type_filter: LookupTypeFilter;
    matched_by: AdminLookupMatchedBy;
  };
  [ADMIN_LOOKUP_EVENTS.OPENED]: {
    entity_type: LookupEntityType;
    via: 'search' | 'recent';
  };
}
