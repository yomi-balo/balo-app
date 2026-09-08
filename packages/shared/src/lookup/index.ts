/**
 * `@balo/shared/lookup` — the BAL-551 admin Lookup vocabulary and result DTO.
 *
 * Barrel only. Everything here is a pure type or a const tuple; see `./types` for the
 * rulings that shape them. Subpath-only (the pino-pulling package root is untouched), so
 * a client component may import `LookupResult` without dragging `postgres` into the
 * bundle (memory `reference_balo_db_client_bundle_footgun`).
 *
 * ⚠ NO `.js` EXTENSION ON THE RELATIVE RE-EXPORT — `@balo/shared` resolves raw TypeScript
 * through its `exports` map (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 */
export {
  LOOKUP_ENTITY_TYPES,
  LOOKUP_TYPE_FILTERS,
  type LookupEntityType,
  type LookupTypeFilter,
  type LookupResult,
  type LookupSearchResult,
} from './types';
export { isLookupUuid } from './uuid';
export { LOOKUP_RESULT_CAP, LOOKUP_ARM_LIMIT, LOOKUP_MIN_QUERY_LENGTH } from './constants';
