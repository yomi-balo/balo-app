'use client';

import { Lock } from 'lucide-react';
import {
  PLATFORM_CAPABILITY_GROUPS,
  PLATFORM_CAPABILITY_LABELS,
  platformCapabilityGroupMembers,
  type PlatformCapability,
} from '@balo/shared/authz';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { CapabilityLock } from '../_lib/staff-access-form';

/**
 * BAL-561 — the grouped capability list. Iterates `PLATFORM_CAPABILITY_GROUPS` →
 * `platformCapabilityGroupMembers`, so the axis's own display metadata (D7) is the single source
 * for both the order and the label — never a page-local copy.
 */
interface CapabilityListProps {
  /** The draft's resolved set — what would be held if the draft were saved right now. */
  readonly resolved: ReadonlySet<PlatformCapability>;
  /** `mode === 'custom' && !readOnly` — outside that, every row is read-only (still visible). */
  readonly editable: boolean;
  readonly lockOf: (capability: PlatformCapability) => CapabilityLock;
  readonly onToggle: (capability: PlatformCapability) => void;
}

export function CapabilityList({
  resolved,
  editable,
  lockOf,
  onToggle,
}: Readonly<CapabilityListProps>): React.JSX.Element {
  return (
    <div>
      {PLATFORM_CAPABILITY_GROUPS.map((group) => (
        <div key={group.key}>
          <p className="text-foreground px-5 pt-4 pb-1.5 text-sm font-semibold">{group.label}</p>
          {platformCapabilityGroupMembers(group.key).map((capability) => {
            const label = PLATFORM_CAPABILITY_LABELS[capability];
            const lock = lockOf(capability);
            const held = resolved.has(capability);
            const rowEditable = editable && lock === null;
            const inputId = `staff-access-capability-${capability}`;
            return (
              <label
                key={capability}
                htmlFor={inputId}
                className={cn(
                  'border-border/60 flex items-start gap-3 border-t px-5 py-2.5 first:border-t-0',
                  rowEditable && 'hover:bg-muted/40 cursor-pointer'
                )}
              >
                <Checkbox
                  id={inputId}
                  checked={held}
                  disabled={!rowEditable}
                  onCheckedChange={() => {
                    if (rowEditable) onToggle(capability);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn('block text-sm font-medium', !held && 'text-muted-foreground')}
                  >
                    {label.name}
                  </span>
                  <span className="text-muted-foreground block font-mono text-xs">
                    {capability}
                  </span>
                  {label.note !== undefined && (
                    <span className="text-muted-foreground mt-1 block text-xs">{label.note}</span>
                  )}
                  {lock === 'floor' && (
                    <span className="text-warning mt-1 flex items-center gap-1 text-xs font-medium">
                      <Lock className="size-3" aria-hidden="true" />
                      {/* pending-MJ */}
                      Removing this leaves no one able to open this page and manage staff.
                    </span>
                  )}
                  {lock === 'super_admin_only' && (
                    <span className="text-primary mt-1 block text-xs font-medium">
                      {/* pending-MJ */}
                      Only a super admin can hold this.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
