'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { approveExpertAction } from '../_actions/approve-expert';

interface ApproveExpertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expertProfileId: string;
  userId: string;
  userEmail: string;
}

export function ApproveExpertDialog({
  open,
  onOpenChange,
  expertProfileId,
  userId,
  userEmail,
}: ApproveExpertDialogProps): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  function handleApprove(): void {
    startTransition(async () => {
      const result = await approveExpertAction(expertProfileId, userId);
      if (result.success) {
        toast.success(`Expert application approved for ${userEmail}.`);
        onOpenChange(false);
      } else {
        toast.error(result.error ?? 'Failed to approve expert.');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve Expert</DialogTitle>
          <DialogDescription>
            This will approve the expert application and switch the user&apos;s active mode to{' '}
            <strong>expert</strong>. They will see the expert onboarding steps on their next
            dashboard visit.
          </DialogDescription>
        </DialogHeader>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            backgroundColor: 'hsl(142 76% 36% / 0.1)',
            border: '1px solid hsl(142 76% 36% / 0.3)',
          }}
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{userEmail}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleApprove} disabled={isPending}>
            {isPending ? 'Approving...' : 'Approve Expert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
