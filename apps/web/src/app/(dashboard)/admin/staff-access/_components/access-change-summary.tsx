import {
  PLATFORM_CAPABILITY_LABELS,
  staffCustomListAllowed,
  type PlatformCapability,
} from '@balo/shared/authz';
import type { PlatformRole } from '@balo/shared/parties';
import { accessDiff } from '../_lib/staff-access-form';
import { STAFF_ACCESS_ROLE_COPY } from '../_lib/staff-access-roles';

/**
 * BAL-561 — the role-move banner plus the capability diff, shared by the confirm dialog and the
 * add-staff dialog's confirm step. Pure presentational, no state.
 */
interface AccessChangeSummaryProps {
  readonly firstName: string;
  readonly roleBefore: PlatformRole;
  readonly roleAfter: PlatformRole;
  readonly before: ReadonlySet<PlatformCapability>;
  readonly after: ReadonlySet<PlatformCapability>;
  readonly customListBefore: boolean;
  readonly customListAfter: boolean;
}

/** The copy for an EMPTY diff — pulled out of the JSX to avoid a nested ternary (S3358). */
function emptyDiffMessage(
  firstName: string,
  roleChanged: boolean,
  customListBefore: boolean,
  customListAfter: boolean
): string {
  if (roleChanged) {
    return `What ${firstName} can do does not change — only the role label moves.`; // pending-MJ
  }
  if (customListAfter && !customListBefore) {
    // pending-MJ
    return `What ${firstName} can do does not change today, but the list will no longer follow the role.`;
  }
  // pending-MJ
  return `What ${firstName} can do does not change today, but the list will follow the role again.`;
}

export function AccessChangeSummary({
  firstName,
  roleBefore,
  roleAfter,
  before,
  after,
  customListBefore,
  customListAfter,
}: Readonly<AccessChangeSummaryProps>): React.JSX.Element {
  const roleChanged = roleBefore !== roleAfter;
  const diff = accessDiff(before, after);
  const hasDiff = diff.added.length > 0 || diff.removed.length > 0;

  return (
    <div className="space-y-3">
      {roleChanged && (
        <div className="bg-muted/50 border-border rounded-lg border p-3 text-sm">
          {/* pending-MJ */}
          Role moves from <strong>{STAFF_ACCESS_ROLE_COPY[roleBefore].title}</strong> to{' '}
          <strong>{STAFF_ACCESS_ROLE_COPY[roleAfter].title}</strong>.
          {/* Data comparison, not a role literal: `staffCustomListAllowed` answers "can this
              role hold anything at all", the same predicate the storage rule uses. */}
          {!staffCustomListAllowed(roleAfter) && ` ${firstName} will leave this list.`}
        </div>
      )}

      {hasDiff ? (
        <ul className="space-y-1 text-sm">
          {diff.added.map((capability) => (
            <li key={capability} className="text-success flex gap-2">
              <span aria-hidden="true" className="font-bold">
                +
              </span>
              <span>{PLATFORM_CAPABILITY_LABELS[capability].name}</span>
            </li>
          ))}
          {diff.removed.map((capability) => (
            <li key={capability} className="text-destructive flex gap-2">
              <span aria-hidden="true" className="font-bold">
                &minus;
              </span>
              <span>{PLATFORM_CAPABILITY_LABELS[capability].name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          {emptyDiffMessage(firstName, roleChanged, customListBefore, customListAfter)}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        {/* pending-MJ */}
        This is recorded against your name and takes effect on {firstName}&rsquo;s next page load.
      </p>
    </div>
  );
}
