'use client';

import { useCallback, useReducer, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  PLATFORM_CAPABILITIES,
  staffCustomListAllowed,
  type PlatformCapability,
  type StaffAccessPerson,
} from '@balo/shared/authz';
import { personDisplayName, type PlatformRole } from '@balo/shared/parties';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { deriveInitials } from '@/lib/format/initials';
import { saveStaffAccessAction } from '../_actions/save-staff-access';
import {
  capabilityLockOf,
  draftCustomListOf,
  initialStaffAccessForm,
  isStaffAccessFormDirty,
  reduceStaffAccessForm,
  resolvedAccessOf,
  roleOptionFloorBlocked,
  saveBlockOf,
} from '../_lib/staff-access-form';
import {
  STAFF_ACCESS_SAVE_MESSAGES,
  staffAccessFailureNeedsReload,
} from '../_lib/staff-access-outcome';
import { STAFF_ACCESS_ROLE_ORDER } from '../_lib/staff-access-roles';
import { CapabilityList } from './capability-list';
import {
  ConfirmAccessChangeDialog,
  type ConfirmAccessChangeError,
} from './confirm-access-change-dialog';
import { RoleBadge } from './role-badge';
import { RoleOptions } from './role-options';

const AXIS_LENGTH = Object.values(PLATFORM_CAPABILITIES).length;

interface StaffAccessDetailProps {
  readonly person: StaffAccessPerson;
  readonly people: readonly StaffAccessPerson[];
  readonly viewerId: string;
}

/**
 * BAL-561 — the Staff access detail form: role picker, "What they can do" custom/follow toggle
 * and grouped capability list, sticky action bar, confirm dialog. The form runs on
 * `useReducer(reduceStaffAccessForm, person, initialStaffAccessForm)`; the PARENT remounts this
 * component (via a `key` derived from the person's id/role/customList) whenever server data
 * changes, which is what resets the form after a save — this component never re-syncs itself.
 *
 * D3 — the viewer's OWN row is fully read-only: a warning banner explains why, and there is no
 * action bar at all (the server refuses every self-save regardless of the UI).
 */
export function StaffAccessDetail({
  person,
  people,
  viewerId,
}: Readonly<StaffAccessDetailProps>): React.JSX.Element {
  const router = useRouter();
  const [state, dispatch] = useReducer(reduceStaffAccessForm, person, initialStaffAccessForm);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // C1/C8 — an EXPLICIT in-flight flag, set true synchronously when the save starts and cleared
  // in the SAME synchronous block as the outcome it produces (`error` or the close). NOT
  // `useTransition`'s `isPending`: that flag's fall back to `false` is scheduled by React's own
  // async-transition completion tracking, a separate mechanism from the `setError` call inside
  // the callback — the two are not guaranteed to land in the same commit. The CI failure on the
  // F3 test (dialog still open after Cancel) is consistent with exactly that gap: Cancel reads
  // `disabled={pending}`, and a click on an already-disabled button dispatches nothing, so a
  // `pending` that is still `true` for one extra render after the error banner appears makes
  // Cancel a silent no-op. `saving` cannot have that gap because there is only one place that
  // ever sets it, and every call site sets it in the same statement group as the state it gates.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ConfirmAccessChangeError | null>(null);

  const isSelf = person.id === viewerId;
  const displayName = personDisplayName(person.firstName, person.lastName, person.email);
  const firstName = person.firstName?.trim() ? person.firstName.trim() : displayName;

  const dirty = isStaffAccessFormDirty(person, state);
  const block = saveBlockOf(people, person, state, viewerId);
  const resolved = resolvedAccessOf(state.role, draftCustomListOf(state));
  const before = resolvedAccessOf(person.role, person.customList);
  const customModeEditable = state.mode === 'custom' && !isSelf;

  const disabledReasonForRole = useCallback(
    (role: PlatformRole): string | null =>
      roleOptionFloorBlocked(people, person, role)
        ? // pending-MJ
          `${firstName} is the only person who can open this page and manage staff. Give someone else that access first.`
        : null,
    [people, person, firstName]
  );

  const lockOf = useCallback(
    (capability: PlatformCapability) => capabilityLockOf(people, person, state, capability, isSelf),
    [people, person, state, isSelf]
  );

  const handleSelectRole = useCallback(
    (role: PlatformRole) => dispatch({ type: 'select_role', role }),
    []
  );
  const handleUseCustom = useCallback(() => dispatch({ type: 'use_custom' }), []);
  const handleFollowRole = useCallback(() => dispatch({ type: 'follow_role' }), []);
  const handleToggle = useCallback(
    (capability: PlatformCapability) => dispatch({ type: 'toggle', capability }),
    []
  );
  const handleDiscard = useCallback(() => dispatch({ type: 'reset', person }), [person]);

  const handleReviewAndSave = useCallback(() => {
    // F3 (R2) — a stale error from a previous attempt must not still be showing the next time
    // the dialog opens on a freshly-edited draft.
    setError(null);
    setConfirmOpen(true);
  }, []);

  const handleReload = useCallback(() => {
    setConfirmOpen(false);
    router.refresh();
  }, [router]);

  const runConfirm = useCallback(async (): Promise<void> => {
    // N4 — `saveStaffAccessAction` is a Server Action: a TRANSPORT-level failure (offline, a 500
    // from the action endpoint, an aborted POST) REJECTS the promise instead of resolving a typed
    // refusal. Without this `try`/`catch`/`finally`, that rejection would propagate out of the
    // fire-and-forget `void runConfirm()` call, `saving` would never clear, and C8's dismiss
    // guard (which keys on `saving`) would strand the dialog open until a page reload — a NEW
    // consequence of C8, so it ships with it.
    try {
      const result = await saveStaffAccessAction({
        targetUserId: person.id,
        expected: {
          role: person.role,
          customList: person.customList === null ? null : [...person.customList],
        },
        next: { role: state.role, customList: draftCustomListOf(state) },
      });
      if (result.success) {
        toast.success(`Access updated for ${firstName}`); // pending-MJ
        setConfirmOpen(false);
        // `revalidatePath` inside the action re-renders the page with fresh data; the parent
        // workspace re-keys this component, which resets the form to the new saved state.
        return;
      }
      toast.error(result.error);
      setError({ message: result.error, needsReload: staffAccessFailureNeedsReload(result.code) });
    } catch (error) {
      Sentry.captureException(error);
      toast.error(STAFF_ACCESS_SAVE_MESSAGES.failed);
      setError({ message: STAFF_ACCESS_SAVE_MESSAGES.failed, needsReload: false });
    } finally {
      // N4 — cleared here, UNCONDITIONALLY, on every path (success, typed refusal, or a raw
      // rejection) so `saving` — and therefore C8's dismiss guard and the Cancel button — can
      // never get stuck true.
      setSaving(false);
    }
  }, [person, state, firstName]);

  const handleConfirm = useCallback((): void => {
    setSaving(true);
    setError(null);
    void runConfirm();
  }, [runConfirm]);

  // C8 — the confirm dialog must not be dismissible (Esc, click-away, or a controlled `false`)
  // while a save is genuinely in flight; once it resolves (success closes it directly, failure
  // shows the banner), dismissal is allowed again. Keys on `saving`, never on a raw transition
  // pending flag — see the `saving` declaration above for why.
  const handleConfirmOpenChange = useCallback(
    (next: boolean) => {
      if (saving && !next) return;
      setConfirmOpen(next);
    },
    [saving]
  );

  return (
    <div>
      <div className="border-border bg-card rounded-2xl border">
        <div className="border-border border-b p-5">
          <div className="flex items-center gap-3.5">
            <Avatar size="lg">
              <AvatarFallback>{deriveInitials(displayName)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground truncate text-lg font-semibold">{displayName}</h2>
              <p className="text-muted-foreground truncate text-sm">{person.email}</p>
            </div>
            <RoleBadge
              role={person.role}
              customListSet={person.customList !== null}
              isLive={person.isLive}
            />
          </div>

          {isSelf && (
            <div className="bg-warning/10 border-warning/40 mt-4 flex items-start gap-2.5 rounded-lg border p-3 text-sm">
              <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {/* pending-MJ */}
              <span>You cannot change your own access. Ask another super admin.</span>
            </div>
          )}
        </div>

        <div className="border-border border-b p-5">
          <p className="text-foreground text-sm font-semibold">Role</p>
          {/* pending-MJ */}
          <p className="text-muted-foreground mt-0.5 mb-3 text-sm">
            Sets the starting list of what they can do.
          </p>
          <RoleOptions
            roles={STAFF_ACCESS_ROLE_ORDER}
            value={state.role}
            onSelect={handleSelectRole}
            disabledReason={disabledReasonForRole}
            disabled={isSelf}
          />
        </div>

        <div className="flex items-center justify-between gap-3 p-5 pb-3">
          <div>
            <h3 className="text-foreground text-sm font-semibold">What they can do</h3>
            <p className="text-muted-foreground mt-0.5 max-w-md text-xs">
              {/* pending-MJ */}
              {state.mode === 'follow'
                ? 'Following the role. Change the role and this list changes with it.'
                : 'A custom list. It replaces the role defaults rather than adding to them. Removing an item blocks that action — a few admin pages stay visible to all staff.'}
            </p>
          </div>
          <div
            role="group"
            aria-label="Access mode"
            className="bg-muted inline-flex rounded-lg border p-1"
          >
            <button
              type="button"
              aria-pressed={state.mode === 'follow'}
              disabled={isSelf}
              onClick={handleFollowRole}
              className={cn(
                // C9 (PR #297 precedent) — 44px minimum tap target and a visible focus ring, same
                // as `lookup-drill-in-tabs.tsx`'s segmented control. `aria-pressed` stays: this is
                // a toggle button pair, not a tablist.
                'focus-visible:ring-ring inline-flex min-h-[44px] items-center justify-center rounded-md px-3 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none',
                state.mode === 'follow'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
            >
              {/* pending-MJ */}
              Follow role
            </button>
            <button
              type="button"
              aria-pressed={state.mode === 'custom'}
              disabled={isSelf || !staffCustomListAllowed(state.role)}
              onClick={handleUseCustom}
              className={cn(
                'focus-visible:ring-ring inline-flex min-h-[44px] items-center justify-center rounded-md px-3 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                state.mode === 'custom'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
            >
              {/* pending-MJ */}
              Custom
            </button>
          </div>
        </div>
        {!staffCustomListAllowed(state.role) && (
          <p className="text-muted-foreground px-5 pb-3 text-xs">
            {/* pending-MJ */}A custom list needs the Admin or Super admin role.
          </p>
        )}

        <CapabilityList
          resolved={resolved}
          editable={customModeEditable}
          lockOf={lockOf}
          onToggle={handleToggle}
        />

        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t p-4 text-sm">
          {/* pending-MJ */}
          <span>
            {resolved.size} of {AXIS_LENGTH} ·{' '}
            {state.mode === 'follow' ? 'from role' : 'set for this person'}
          </span>
          {state.mode === 'custom' && !isSelf && (
            <button type="button" onClick={handleFollowRole} className="text-primary font-medium">
              {/* pending-MJ */}
              Go back to following the role
            </button>
          )}
        </div>
      </div>

      {!isSelf && (
        <div className="border-border bg-card sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 shadow-lg">
          <div className="text-sm">
            {/* pending-MJ */}
            <span className="text-foreground font-medium">
              {dirty ? 'Unsaved changes' : 'No changes'}
            </span>
            {block === 'floor' && (
              <p className="text-warning mt-0.5 text-xs">
                {STAFF_ACCESS_SAVE_MESSAGES.floor_violation}
              </p>
            )}
            {block === 'ineligible' && (
              <p className="text-warning mt-0.5 text-xs">
                {STAFF_ACCESS_SAVE_MESSAGES.target_ineligible}
              </p>
            )}
            {block === 'grant_exceeds_actor' && (
              <p className="text-warning mt-0.5 text-xs">
                {STAFF_ACCESS_SAVE_MESSAGES.grant_exceeds_actor}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!dirty} onClick={handleDiscard}>
              {/* pending-MJ */}
              Discard
            </Button>
            <Button disabled={block !== null} onClick={handleReviewAndSave}>
              {/* pending-MJ */}
              Review and save
            </Button>
          </div>
        </div>
      )}

      <ConfirmAccessChangeDialog
        open={confirmOpen}
        onOpenChange={handleConfirmOpenChange}
        firstName={firstName}
        pending={saving}
        onConfirm={handleConfirm}
        roleBefore={person.role}
        roleAfter={state.role}
        before={before}
        after={resolved}
        customListBefore={person.customList !== null}
        customListAfter={state.mode === 'custom'}
        error={error}
        onReload={handleReload}
      />
    </div>
  );
}
