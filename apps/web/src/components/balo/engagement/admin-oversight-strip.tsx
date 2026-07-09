import { AlertCircle, Clock, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { AdminOversightView } from '@/lib/engagement/engagement-view';
import { AdminCancelButton } from './admin-cancel-button';

interface AdminOversightStripProps {
  oversight: AdminOversightView;
  engagementId: string;
}

/**
 * Admin-lens oversight strip. The view mapper returns `adminOversight === null`
 * for non-admin lenses AND only on active | pending_acceptance engagements — i.e.
 * exactly the cancellable states — so the composer only mounts this for admins and the
 * {@link AdminCancelButton} can always render. Surfaces last-activity, an
 * INFORMATIONAL stalled pill + note, and the "Cancel engagement" danger action (D4).
 */
export function AdminOversightStrip({
  oversight,
  engagementId,
}: Readonly<AdminOversightStripProps>): React.JSX.Element {
  return (
    <Card className="border-border bg-card px-[18px] py-3.5">
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        Oversight
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-border bg-muted text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {oversight.lastActivityLabel}
        </Badge>
        {oversight.stalled && (
          <Badge className="border-destructive/20 bg-destructive/10 text-destructive">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            Stalled
          </Badge>
        )}
        <AdminCancelButton engagementId={engagementId} />
      </div>
      {oversight.stalled && oversight.stalledNote !== null && (
        <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
          {oversight.stalledNote}
        </p>
      )}
    </Card>
  );
}
