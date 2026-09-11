import type { LookupEntityType, LookupTypeFilter } from '@balo/shared/lookup';

/**
 * BAL-551/BAL-555 — the admin Lookup surface's CLIENT event family (one search box across
 * entity types). All three events are browser-emitted; there is no server family.
 */
export const ADMIN_LOOKUP_EVENTS = {
  SEARCHED: 'admin_lookup_searched',
  OPENED: 'admin_lookup_opened',
  /** BAL-555 — an EXPLICIT tab click in the drill-in (never the default render). */
  TAB_SELECTED: 'admin_lookup_tab_selected',
} as const;

/**
 * How the QUERY looked, not which column matched — a shape heuristic over the input, computed
 * by `classifyLookupQuery` (apps/web). Its docblock says so; do not read this as match
 * provenance.
 */
export type AdminLookupMatchedBy = 'name' | 'email' | 'id';

/**
 * The drill-in's two tab keys. Mirrors `apps/web`'s `LookupDrillInTab`
 * (`admin/lookup/_components/lookup-drill-in-tabs.tsx`) without importing it — `@balo/analytics`
 * is a lower-level package apps/web depends ON, never the reverse.
 */
export type AdminLookupDrillInTab = 'timeline' | 'money';

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
  [ADMIN_LOOKUP_EVENTS.TAB_SELECTED]: {
    entity_type: LookupEntityType;
    tab: AdminLookupDrillInTab;
  };
}
