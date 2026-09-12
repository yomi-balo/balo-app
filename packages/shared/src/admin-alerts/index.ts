/**
 * `@balo/shared/admin-alerts` (BAL-548 / ADR-1055) — the pending-actions queue's shared
 * vocabulary.
 *
 * ⚠ `packages/shared` imports NO db, no `node:crypto`, no React, no I/O. This module is pure
 * data + pure functions: the evidence snapshot type (`./detail`), the group/cadence/entity-type
 * vocabularies (`./groups`), the KIND REGISTRY (`./kinds` — twelve kinds, `target()`, the
 * note-closeable set, the per-cadence partition), the sweep sentinel + storm helpers
 * (`./storm`), and the tuned constants (`./constants`).
 *
 * Finder implementations, the sweep, and every `raise()` call site live in `apps/api`, keyed
 * BY NAME so this package stays db-free — see `AdminAlertKindMeta.finder`.
 */
export type { AdminAlertDetail, AdminAlertMoney } from './detail';

export {
  ADMIN_ALERT_GROUPS,
  ADMIN_ALERT_GROUP_ORDER,
  ADMIN_ALERT_CADENCES,
  type AdminAlertTileGroup,
  type AdminAlertGroup,
  type AdminAlertCadence,
  type AdminAlertEntityType,
} from './groups';

export {
  ADMIN_ALERT_KIND_KEYS,
  ADMIN_ALERT_KINDS,
  NOTE_CLOSEABLE_KINDS,
  isKnownAdminAlertKind,
  isNoteCloseableKind,
  adminAlertKindsForCadence,
  type AdminAlertKind,
  type AdminAlertKindMeta,
  type AdminAlertTarget,
  type AdminAlertTargetInput,
  type ResolvedAdminAlertKind,
} from './kinds';

export {
  ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID,
  ADMIN_ALERT_STORM_KIND_SUFFIX,
  stormKindFor,
  baseKindOfStormKind,
  isStormKind,
  resolveAdminAlertKind,
} from './storm';

export {
  ADMIN_ALERT_STORM_THRESHOLD,
  ADMIN_ALERT_STORM_SAMPLE_LIMIT,
  ADMIN_ALERT_PAGE_SIZE,
  ADMIN_ALERT_AGE_EMPHASIS_DAYS,
  ADMIN_ALERT_NOTE_MIN,
  ADMIN_ALERT_NOTE_MAX,
  ADMIN_ALERT_FINDER_BATCH_LIMIT,
  TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS,
} from './constants';
