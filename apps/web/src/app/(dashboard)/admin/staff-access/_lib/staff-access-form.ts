import {
  accountMayGainAccess,
  applyStaffAccessDraft,
  canonicalCustomList,
  customListCanHold,
  platformCapabilityDisplayOrder,
  resolvePlatformCapabilities,
  sameCustomList,
  staffCustomListAllowed,
  staffManagementFloorHolds,
  type PlatformCapability,
  type StaffAccessDraft,
  type StaffAccessPerson,
} from '@balo/shared/authz';
import type { PlatformRole } from '@balo/shared/parties';

/**
 * BAL-561 — the pure client-side state machine behind the Staff access detail form. No I/O, no
 * `server-only` — every rule here PREVIEWS what the save transaction will decide (D2's floor, D9's
 * "Custom needs a staff role", the storage token restriction), through the SAME shared rule
 * module the repository locks and evaluates against (`@balo/shared/authz`). The transaction is
 * still the enforcement point: a save the UI didn't catch (a concurrent change) surfaces the
 * transaction's own named refusal rather than a generic failure.
 *
 * Ruling 1 — a role change ALWAYS resets the mode to "follow the new role" (override → the role's
 * bundle). There is no inline keep-or-reset choice: an operator who wants a custom list on the new
 * role clicks "Custom" again, which pre-fills from THAT role's bundle (D9's one-click "admin minus
 * promo codes" affordance, reachable in two clicks instead of a collision dialog).
 */

export interface StaffAccessFormState {
  readonly role: PlatformRole;
  readonly mode: 'follow' | 'custom';
  /**
   * The CUSTOM DRAFT — meaningful only in `mode: 'custom'`. In `mode: 'follow'` this field is not
   * read by {@link draftCustomListOf} (which returns `null` in follow mode regardless of this
   * value) and may be stale.
   *
   * F2 (R1) — what actually happens on the two `use_custom` transitions, stated precisely because
   * this comment previously overclaimed "does not lose work" for BOTH of them:
   *   · Follow → Custom RE-FILLS this field from the current draft role's bundle (D9's one-click
   *     "admin minus promo codes" affordance) — this DOES discard whatever was here before, which
   *     is correct, because in follow mode this field was stale by definition.
   *   · Custom → `use_custom` again is a NO-OP (`reduceStaffAccessForm` returns the same state
   *     unchanged) — this is the case that must never lose work, because a stored custom list's
   *     edits are live in this field already and a second press of an already-pressed "Custom"
   *     control is not a transition.
   * Discard (`reset`) is the only way back to the SAVED custom list once here.
   */
  readonly customList: readonly PlatformCapability[];
}

export type StaffAccessFormEvent =
  | { readonly type: 'select_role'; readonly role: PlatformRole }
  | { readonly type: 'use_custom' }
  | { readonly type: 'follow_role' }
  | { readonly type: 'toggle'; readonly capability: PlatformCapability }
  | { readonly type: 'reset'; readonly person: StaffAccessPerson };

export function initialStaffAccessForm(person: StaffAccessPerson): StaffAccessFormState {
  return {
    role: person.role,
    mode: person.customList === null ? 'follow' : 'custom',
    customList: resolvePlatformCapabilities(person.role, person.customList),
  };
}

export function reduceStaffAccessForm(
  state: StaffAccessFormState,
  event: StaffAccessFormEvent
): StaffAccessFormState {
  switch (event.type) {
    case 'select_role': {
      if (event.role === state.role) return state;
      // Ruling 1: every role change resets to follow-role, pre-filled from the NEW role's bundle.
      return {
        role: event.role,
        mode: 'follow',
        customList: resolvePlatformCapabilities(event.role, null),
      };
    }
    case 'use_custom': {
      // F2 (R1) — already in custom mode: a no-op. Re-filling here would wipe whatever the
      // operator had just been editing every time "Custom" (already pressed) is clicked again.
      if (state.mode === 'custom') return state;
      // D9 — Custom is unavailable for a role that cannot hold a custom list (`user`).
      if (!staffCustomListAllowed(state.role)) return state;
      // D9 pre-fill: from the current DRAFT role's bundle, one click to "admin minus promo codes".
      return {
        ...state,
        mode: 'custom',
        customList: resolvePlatformCapabilities(state.role, null),
      };
    }
    case 'follow_role':
      return { ...state, mode: 'follow' };
    case 'toggle': {
      if (state.mode !== 'custom' || !customListCanHold(state.role, event.capability)) return state;
      const next = state.customList.includes(event.capability)
        ? state.customList.filter((capability) => capability !== event.capability)
        : [...state.customList, event.capability];
      return { ...state, customList: canonicalCustomList(next) };
    }
    case 'reset':
      return initialStaffAccessForm(event.person);
    default:
      return event satisfies never;
  }
}

/** The draft customList the save will store: `null` (follow the role) or a canonical list. */
export function draftCustomListOf(state: StaffAccessFormState): PlatformCapability[] | null {
  return state.mode === 'custom' ? canonicalCustomList(state.customList) : null;
}

/** The RESOLVED set for a (role, customList) pair — the same rule the axis resolves everywhere. */
export function resolvedAccessOf(
  role: PlatformRole,
  customList: readonly PlatformCapability[] | null
): ReadonlySet<PlatformCapability> {
  return new Set(resolvePlatformCapabilities(role, customList));
}

/** Has the draft diverged from the person's SAVED state? */
export function isStaffAccessFormDirty(
  person: StaffAccessPerson,
  state: StaffAccessFormState
): boolean {
  return state.role !== person.role || !sameCustomList(draftCustomListOf(state), person.customList);
}

export interface StaffAccessDiff {
  readonly added: readonly PlatformCapability[];
  readonly removed: readonly PlatformCapability[];
}

/** The capability diff between two resolved sets, ordered by the Staff access page's display order. */
export function accessDiff(
  before: ReadonlySet<PlatformCapability>,
  after: ReadonlySet<PlatformCapability>
): StaffAccessDiff {
  const order = platformCapabilityDisplayOrder();
  return {
    added: order.filter((capability) => after.has(capability) && !before.has(capability)),
    removed: order.filter((capability) => before.has(capability) && !after.has(capability)),
  };
}

/**
 * Would picking `role` for `person` leave nobody able to keep the staff-management floor? A role
 * pick always resets to follow-role, so `(role, null)` IS the draft this previews — always
 * evaluated, never conditionally skipped. The viewer is themselves a floor holder and can never be
 * the target (D3 — self-edits are refused outright), so the baseline set this checks against never
 * itself violates the floor.
 */
export function roleOptionFloorBlocked(
  people: readonly StaffAccessPerson[],
  person: StaffAccessPerson,
  role: PlatformRole
): boolean {
  return !staffManagementFloorHolds(
    applyStaffAccessDraft(people, person, { role, customList: null })
  );
}

export type CapabilityLock = 'floor' | 'super_admin_only' | null;

/**
 * Why (if at all) a capability row is locked from editing in the CURRENT draft:
 *   · the record is the VIEWER'S OWN (D3, F9) — already fully read-only, so no lock line is
 *     needed on top of the already-disabled checkboxes; `isSelf` is THREADED from the caller
 *     (which already knows it from comparing the session to the record) rather than re-derived
 *     here from a `viewerId` this function would otherwise need to accept;
 *   · outside custom mode, nothing is locked — the row is read-only for a different reason;
 *   · a token the draft role cannot hold at all (only `MANAGE_STAFF_CAPABILITIES` today, and only
 *     off a `super_admin` role) is `'super_admin_only'`;
 *   · a HELD token whose removal would leave nobody keeping the staff-management floor is
 *     `'floor'`.
 */
export function capabilityLockOf(
  people: readonly StaffAccessPerson[],
  person: StaffAccessPerson,
  state: StaffAccessFormState,
  capability: PlatformCapability,
  isSelf: boolean
): CapabilityLock {
  if (isSelf) return null;
  if (state.mode !== 'custom') return null;
  if (!customListCanHold(state.role, capability)) return 'super_admin_only';
  if (!state.customList.includes(capability)) return null;
  const without = state.customList.filter((held) => held !== capability);
  const wouldStillHold = staffManagementFloorHolds(
    applyStaffAccessDraft(people, person, { role: state.role, customList: without })
  );
  return wouldStillHold ? null : 'floor';
}

export type SaveBlock = 'self' | 'not_dirty' | 'ineligible' | 'floor' | null;

/** Why (if at all) "Review and save" is disabled for the current draft. */
export function saveBlockOf(
  people: readonly StaffAccessPerson[],
  person: StaffAccessPerson,
  state: StaffAccessFormState,
  viewerId: string
): SaveBlock {
  if (person.id === viewerId) return 'self';
  if (!isStaffAccessFormDirty(person, state)) return 'not_dirty';
  const draft: StaffAccessDraft = { role: state.role, customList: draftCustomListOf(state) };
  // F1 (S1/S2) — the SAME predicate the save transaction consults, so the UI and the transaction
  // agree on when a draft is a pure reduction (always allowed) versus a GAIN (blocked for an
  // ineligible — suspended or unverified — target).
  const before = resolvedAccessOf(person.role, person.customList);
  const after = resolvedAccessOf(draft.role, draft.customList);
  const gainsCapability = [...after].some((capability) => !before.has(capability));
  if (gainsCapability && !accountMayGainAccess(person)) return 'ineligible';
  if (!staffManagementFloorHolds(applyStaffAccessDraft(people, person, draft))) return 'floor';
  return null;
}
