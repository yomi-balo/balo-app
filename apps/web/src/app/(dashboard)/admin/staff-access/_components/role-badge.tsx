import { ShieldCheck } from 'lucide-react';
import type { PlatformRole } from '@balo/shared/parties';
import { Badge } from '@/components/ui/badge';
import { STAFF_ACCESS_ROLE_COPY } from '../_lib/staff-access-roles';

/**
 * BAL-561 — presentational, no test (a badge is a badge). Looks up
 * `STAFF_ACCESS_ROLE_COPY[role]` for the title and tone — no role comparisons of its own.
 */
interface RoleBadgeProps {
  readonly role: PlatformRole;
  readonly customListSet: boolean;
  readonly isLive: boolean;
}

export function RoleBadge({
  role,
  customListSet,
  isLive,
}: Readonly<RoleBadgeProps>): React.JSX.Element {
  const copy = STAFF_ACCESS_ROLE_COPY[role];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={copy.tone === 'primary' ? 'default' : 'outline'} className="gap-1">
        {copy.tone === 'primary' && <ShieldCheck className="size-3" aria-hidden="true" />}
        {copy.title}
      </Badge>
      {customListSet && (
        <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
          {/* pending-MJ */}
          Custom access
        </Badge>
      )}
      {!isLive && (
        <Badge variant="outline" className="text-muted-foreground">
          {/* pending-MJ */}
          Suspended
        </Badge>
      )}
    </div>
  );
}
