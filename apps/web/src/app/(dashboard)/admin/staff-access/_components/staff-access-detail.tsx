'use client';

import { useCallback, useReducer, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
  const [pending, startTransition] = useTransition();
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

  const handleConfirm = useCallback(() => {
    startTransition(async () => {
      setError(null);
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
    });
  }, [person, state, firstName]);

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
                'rounded-md px-3 py-1.5 text-xs font-medium',
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
                'rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
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
        onOpenChange={setConfirmOpen}
        firstName={firstName}
        pending={pending}
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
