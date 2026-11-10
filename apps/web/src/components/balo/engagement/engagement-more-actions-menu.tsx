'use client';

import { useCallback, useState } from 'react';
import { Ban, Link2, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import { CancelEngagementModal, type CancelDialogCopy } from './cancel-engagement-modal';

interface EngagementMoreActionsMenuProps {
  engagementId: string;
  deliveryStatus: 'active' | 'pending_acceptance';
  cancelDialog: CancelDialogCopy;
}

/**
 * The header's "More actions" menu: copy the project link, and, for Balo staff, cancel the
 * project. The page renders it only when the viewer holds the cancel capability, so the
 * menu itself checks nothing. Cancelling lives here rather than as a standing button so it
 * is never one stray click away.
 */
export function EngagementMoreActionsMenu({
  engagementId,
  deliveryStatus,
  cancelDialog,
}: Readonly<EngagementMoreActionsMenuProps>): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);

  const copyLink = useCallback((): void => {
    const url = `${globalThis.location.origin}/engagements/${engagementId}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.error("Couldn't copy the link. Copy it from the address bar instead.")
    );
  }, [engagementId]);

  const openDialog = useCallback((): void => {
    track(ENGAGEMENT_EVENTS.CANCEL_DIALOG_OPENED, {
      engagement_id: engagementId,
      delivery_status: deliveryStatus,
    });
    setDialogOpen(true);
  }, [engagementId, deliveryStatus]);
  const closeDialog = useCallback((): void => setDialogOpen(false), []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="More actions">
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={copyLink}>
            <Link2 aria-hidden />
            Copy project link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={openDialog}>
            <Ban aria-hidden />
            Cancel project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CancelEngagementModal
        open={dialogOpen}
        engagementId={engagementId}
        deliveryStatus={deliveryStatus}
        dialog={cancelDialog}
        onClose={closeDialog}
      />
    </>
  );
}
