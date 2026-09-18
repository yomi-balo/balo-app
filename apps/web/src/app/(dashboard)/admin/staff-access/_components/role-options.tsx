'use client';

import type { PlatformRole } from '@balo/shared/parties';
import { cn } from '@/lib/utils';
import { STAFF_ACCESS_ROLE_COPY } from '../_lib/staff-access-roles';

/**
 * BAL-561 — the role picker, shared by the detail form and the add-staff promote step. A
 * hand-rolled `role="radiogroup"` (no shadcn RadioGroup primitive dependency needed here), each
 * option a `button[role="radio"]` with the blocked reason rendered as VISIBLE text
 * (`aria-describedby`), never a hover-only tooltip (CLAUDE.md).
 */
interface RoleOptionsProps {
  readonly roles: readonly PlatformRole[];
  readonly value: PlatformRole;
  readonly onSelect: (role: PlatformRole) => void;
  /** `null` when the role is selectable; otherwise the visible reason it is blocked. */
  readonly disabledReason: (role: PlatformRole) => string | null;
  /** Blocks every option, e.g. the self-row (D3). */
  readonly disabled?: boolean;
}

export function RoleOptions({
  roles,
  value,
  onSelect,
  disabledReason,
  disabled = false,
}: Readonly<RoleOptionsProps>): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Role" className="grid gap-2">
      {roles.map((role) => {
        const copy = STAFF_ACCESS_ROLE_COPY[role];
        const reason = disabled ? null : disabledReason(role);
        const isDisabled = disabled || reason !== null;
        const descriptionId = `staff-access-role-${role}-blocked`;
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={value === role}
            aria-describedby={reason === null ? undefined : descriptionId}
            disabled={isDisabled}
            onClick={() => onSelect(role)}
            className={cn(
              'border-border flex min-h-[44px] w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
              value === role && 'border-primary bg-primary/5',
              !isDisabled && value !== role && 'hover:border-primary/40',
              isDisabled && 'cursor-not-allowed opacity-60'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                value === role ? 'border-primary' : 'border-border'
              )}
            >
              {value === role && <span className="bg-primary size-2 rounded-full" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm font-semibold">{copy.title}</span>
              <span className="text-muted-foreground mt-0.5 block text-xs">{copy.description}</span>
              {reason !== null && (
                <span id={descriptionId} className="text-warning mt-1.5 block text-xs font-medium">
                  {reason}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
