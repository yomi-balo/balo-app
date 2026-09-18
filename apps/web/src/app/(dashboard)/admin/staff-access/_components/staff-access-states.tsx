'use client';

import { ShieldCheck, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-561 — the roster's empty state and the loader's denial state.
 *
 * `StaffAccessEmptyState` is INVITATION copy, not absence-framed (CLAUDE.md's empty-state rule):
 * "no one has staff access" is an action the viewer (a super admin, by construction of reaching
 * this state at all) can take from here, so the section stays and leads with the action.
 */
export function StaffAccessEmptyState({
  onGiveAccess,
}: Readonly<{ onGiveAccess: () => void }>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-6 py-14 text-center">
      <Users className="text-muted-foreground mx-auto size-7" aria-hidden="true" />
      <h3 className="text-foreground mt-3 text-base font-semibold">
        {/* pending-MJ */}
        Give someone staff access
      </h3>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        Staff access lets someone open the Balo admin area. Find them by the email they signed up
        with.
      </p>
      <Button onClick={onGiveAccess} className="mt-4">
        {/* pending-MJ */}
        Give someone access
      </Button>
    </div>
  );
}

/** D5 — reached when a staff member without `MANAGE_STAFF_CAPABILITIES` loads the loader's DTO. */
export function StaffAccessNoAccess(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-6 py-14 text-center">
      <ShieldCheck className="text-muted-foreground mx-auto size-7" aria-hidden="true" />
      <h3 className="text-foreground mt-3 text-base font-semibold">
        {/* pending-MJ */}
        Only people who manage staff can open this page
      </h3>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
        {/* pending-MJ */}
        Ask a super admin if someone&rsquo;s access needs to change.
      </p>
    </div>
  );
}
