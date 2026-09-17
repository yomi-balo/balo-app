'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { staffCustomListAllowed, type StaffAccessPerson } from '@balo/shared/authz';
import { personDisplayName, type PlatformRole } from '@balo/shared/parties';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputFloating } from '@/components/enhanced/input-floating';
import { deriveInitials } from '@/lib/format/initials';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { findStaffCandidateAction } from '../_actions/find-staff-candidate';
import { saveStaffAccessAction } from '../_actions/save-staff-access';
import { findStaffCandidateInputSchema } from '../_lib/staff-access-schema';
import { resolvedAccessOf } from '../_lib/staff-access-form';
import {
  STAFF_CANDIDATE_MESSAGES,
  staffAccessFailureNeedsReload,
} from '../_lib/staff-access-outcome';
import { STAFF_ACCESS_ROLE_ORDER } from '../_lib/staff-access-roles';
import { AccessChangeSummary } from './access-change-summary';
import type { ConfirmAccessChangeError } from './confirm-access-change-dialog';
import { RoleOptions } from './role-options';

const PROMOTABLE_ROLES = STAFF_ACCESS_ROLE_ORDER.filter((role) => staffCustomListAllowed(role));

type AddStaffStep = 'lookup' | 'promote' | 'confirm';

interface AddStaffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectPerson: (personId: string) => void;
}

/**
 * BAL-561 (ruling 3) — "Give someone access": a real three-step flow, not a stub button. Exact,
 * case-insensitive email lookup; ONE generic "No account found with that email." on a miss — no
 * partial matching, no listing.
 *
 * ⚠ C2 — TAKES NO `people` PROP, DELIBERATELY. It used to take the roster and classify
 * "already staff" from it, which is exactly the STALE-roster bug C2 fixed: `people` is loaded
 * with the page and can be out of date by the time this dialog runs a fresh lookup. Every
 * decision here reads the FRESH lookup result instead (`staffCustomListAllowed(result.person.role)`
 * for the classification, a `router.refresh()` before selecting an existing match).
 */
export function AddStaffDialog({
  open,
  onOpenChange,
  onSelectPerson,
}: Readonly<AddStaffDialogProps>): React.JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<AddStaffStep>('lookup');
  const [email, setEmail] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupPending, startLookup] = useTransition();
  const [candidate, setCandidate] = useState<StaffAccessPerson | null>(null);
  const [alreadyStaff, setAlreadyStaff] = useState<StaffAccessPerson | null>(null);
  const [role, setRole] = useState<PlatformRole>(PROMOTABLE_ROLES[0] ?? 'admin');
  const [savePending, startSave] = useTransition();
  const [saveError, setSaveError] = useState<ConfirmAccessChangeError | null>(null);

  const reset = useCallback(() => {
    setStep('lookup');
    setEmail('');
    setLookupError(null);
    setCandidate(null);
    setAlreadyStaff(null);
    setRole(PROMOTABLE_ROLES[0] ?? 'admin');
    setSaveError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if ((lookupPending || savePending) && !next) return;
      if (!next) reset();
      onOpenChange(next);
    },
    [lookupPending, savePending, reset, onOpenChange]
  );

  const handleFindAccount = useCallback((): void => {
    const parsed = findStaffCandidateInputSchema.safeParse({ email });
    if (!parsed.success) {
      setLookupError(STAFF_CANDIDATE_MESSAGES.invalid);
      return;
    }
    setLookupError(null);
    setAlreadyStaff(null);
    startLookup(async () => {
      const result = await findStaffCandidateAction(parsed.data);
      if (!result.success) {
        setLookupError(result.error);
        if (result.code !== 'not_found') toast.error(result.error);
        return;
      }
      // C2 — classify from the FRESH lookup result, never from `people` (the roster loaded with
      // the page, which can be stale by the time this dialog runs). `staffCustomListAllowed` is
      // the surface's sanctioned "is this role staff" proxy (the no-role-read invariant permits
      // it), so this reads the same fresh row the save itself will re-check server-side.
      if (staffCustomListAllowed(result.person.role)) {
        setAlreadyStaff(result.person);
        return;
      }
      setCandidate(result.person);
      setRole(PROMOTABLE_ROLES[0] ?? 'admin');
      setStep('promote');
    });
  }, [email]);

  const handleReviewAndSave = useCallback((): void => {
    // N2 (same shape as F3 in the detail view) — a stale error from a previous save attempt must
    // not still be showing the next time the confirm step opens on a freshly-edited draft (fail →
    // Back → pick another role → Review and save).
    setSaveError(null);
    setStep('confirm');
  }, []);

  const handleReload = useCallback((): void => {
    // F4 (R3) — matches the confirm dialog's idiom: re-fetch the page, then close.
    router.refresh();
    handleOpenChange(false);
  }, [router, handleOpenChange]);

  const handleOpenExisting = useCallback((): void => {
    if (alreadyStaff === null) return;
    // C2 part 2 — the roster `people` came from is exactly what led here (it looked new to it);
    // refresh so the detail pane the parent renders for this id is not empty.
    router.refresh();
    onSelectPerson(alreadyStaff.id);
    handleOpenChange(false);
  }, [alreadyStaff, onSelectPerson, handleOpenChange, router]);

  const handleConfirm = useCallback((): void => {
    if (candidate === null) return;
    setSaveError(null);
    startSave(async () => {
      const result = await saveStaffAccessAction({
        targetUserId: candidate.id,
        // C2 part 3 — this flow's own premise is "the candidate is a plain user", so state THAT,
        // never `candidate.role`/`candidate.customList` (which is only as fresh as the lookup that
        // ran when this dialog opened). If someone else promoted or restricted the candidate since,
        // the D6 stale check on the server refuses rather than silently overwriting their change.
        expected: { role: 'user', customList: null },
        next: { role, customList: null },
      });
      if (result.success) {
        const name = personDisplayName(candidate.firstName, candidate.lastName, candidate.email);
        toast.success(`${name} now has staff access`); // pending-MJ
        onSelectPerson(candidate.id);
        handleOpenChange(false);
        return;
      }
      toast.error(result.error);
      setSaveError({
        message: result.error,
        needsReload: staffAccessFailureNeedsReload(result.code),
      });
    });
  }, [candidate, role, onSelectPerson, handleOpenChange]);

  const candidateName =
    candidate === null
      ? ''
      : personDisplayName(candidate.firstName, candidate.lastName, candidate.email);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {step === 'lookup' && (
          <>
            <DialogHeader>
              {/* pending-MJ */}
              <DialogTitle>Give someone access</DialogTitle>
              <DialogDescription>Find them by the email they signed up with.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <InputFloating
                type="email"
                label="Email they signed up with"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={lookupPending}
              />
              {lookupError !== null && alreadyStaff === null && (
                <p role="alert" className="text-destructive text-sm">
                  {lookupError}
                </p>
              )}
              {alreadyStaff !== null && (
                <div className="border-border bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3">
                  <span className="text-sm">
                    {/* pending-MJ */}
                    {personDisplayName(
                      alreadyStaff.firstName,
                      alreadyStaff.lastName,
                      alreadyStaff.email
                    )}{' '}
                    already has staff access.
                  </span>
                  <Button type="button" size="sm" onClick={handleOpenExisting}>
                    {/* pending-MJ */}
                    Open their access
                  </Button>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleFindAccount} disabled={lookupPending}>
                {lookupPending && (
                  <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                )}
                {/* pending-MJ */}
                Find account
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'promote' && candidate !== null && (
          <>
            <DialogHeader>
              {/* pending-MJ */}
              <DialogTitle>Give {candidateName} staff access</DialogTitle>
              <DialogDescription>Choose the role they start with.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="border-border flex items-center gap-3 rounded-lg border p-3">
                <Avatar>
                  <AvatarFallback>{deriveInitials(candidateName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{candidateName}</p>
                  <p className="text-muted-foreground truncate text-xs">{candidate.email}</p>
                </div>
              </div>
              <RoleOptions
                roles={PROMOTABLE_ROLES}
                value={role}
                onSelect={setRole}
                disabledReason={() => null}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep('lookup')}>
                Back
              </Button>
              <Button type="button" onClick={handleReviewAndSave}>
                {/* pending-MJ */}
                Review and save
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'confirm' && candidate !== null && (
          <>
            <DialogHeader>
              {/* pending-MJ */}
              <DialogTitle>Give {candidateName} staff access?</DialogTitle>
              {/* pending-MJ */}
              <DialogDescription>Review what this grants before you save.</DialogDescription>
            </DialogHeader>
            <AccessChangeSummary
              firstName={candidateName}
              roleBefore={candidate.role}
              roleAfter={role}
              before={resolvedAccessOf(candidate.role, candidate.customList)}
              after={resolvedAccessOf(role, null)}
              customListBefore={candidate.customList !== null}
              customListAfter={false}
            />
            {saveError !== null && (
              <div
                role="alert"
                aria-live="polite"
                className="bg-destructive/10 border-destructive/30 text-destructive flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
              >
                <span>{saveError.message}</span>
                {saveError.needsReload && (
                  <Button type="button" variant="outline" size="sm" onClick={handleReload}>
                    {/* pending-MJ */}
                    Reload
                  </Button>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('promote')}
                disabled={savePending}
              >
                Back
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={savePending}>
                {savePending && (
                  <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                )}
                {/* pending-MJ */}
                Save changes
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
