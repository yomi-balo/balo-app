import type { AdminAlertKind, ResolvedAdminAlertKind } from './kinds';
import { ADMIN_ALERT_KINDS, isKnownAdminAlertKind } from './kinds';

/**
 * BAL-548 / ADR-1055 — the sweep sentinel + storm vocabulary.
 *
 * ⚠ THE SWEEP SENTINEL. `entity_id` is NOT NULL (a NULL defeats the partial-unique arbiter),
 * so a row that is about the SWEEP rather than about an entity needs a stable uuid that names
 * no row in any table. A fixed, hand-written v4 literal — never `randomUUID()`, which would
 * mint a new "entity" per process and defeat the one-open-row-per-kind rule this whole design
 * rests on.
 */
export const ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID = '00000000-0000-4000-8000-000000005548';

export const ADMIN_ALERT_STORM_KIND_SUFFIX = '.storm';

/** `recording.failed` → `recording.failed.storm`. */
export function stormKindFor(kind: AdminAlertKind): string {
  return `${kind}${ADMIN_ALERT_STORM_KIND_SUFFIX}`;
}

/** `recording.failed.storm` → `recording.failed`; anything else (incl. an unknown base) → null. */
export function baseKindOfStormKind(kind: string): AdminAlertKind | null {
  if (!kind.endsWith(ADMIN_ALERT_STORM_KIND_SUFFIX)) {
    return null;
  }
  const base = kind.slice(0, kind.length - ADMIN_ALERT_STORM_KIND_SUFFIX.length);
  return isKnownAdminAlertKind(base) ? (base as AdminAlertKind) : null;
}

/** Whether `kind` is a DERIVED `<base>.storm` kind of a registered kind. */
export function isStormKind(kind: string): boolean {
  return baseKindOfStormKind(kind) !== null;
}

/**
 * Resolve ANY persisted `kind` string to its metadata — a registered kind, or a derived
 * `<base>.storm` kind, which inherits its base's `group` and `target` and is ALWAYS
 * sweep-closed (never note-closeable: the same tick that drops below the threshold resolves
 * it). Returns `null` for anything else — including `__proto__`/`constructor` (guarded via
 * {@link isKnownAdminAlertKind}'s `Object.hasOwn`).
 */
export function resolveAdminAlertKind(kind: string): ResolvedAdminAlertKind | null {
  const stormBase = baseKindOfStormKind(kind);
  if (stormBase !== null) {
    return { kind, baseKind: stormBase, isStorm: true, meta: ADMIN_ALERT_KINDS[stormBase] };
  }
  if (isKnownAdminAlertKind(kind)) {
    const baseKind = kind as AdminAlertKind;
    return { kind, baseKind, isStorm: false, meta: ADMIN_ALERT_KINDS[baseKind] };
  }
  return null;
}
