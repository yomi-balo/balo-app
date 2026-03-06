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
import { deleteUserAction } from '../_actions/delete-user';

interface DeleteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
}

export function DeleteUserDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
}: DeleteUserDialogProps): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  function handleDelete(): void {
    startTransition(async () => {
      const result = await deleteUserAction(userId);
      if (result.success) {
        if (result.warning) {
          toast.warning(result.warning);
        } else {
          toast.success(`User ${userEmail} deleted successfully.`);
        }
        onOpenChange(false);
      } else {
        toast.error(result.error ?? 'Failed to delete user.');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>
            This action is <strong>irreversible</strong>. It will permanently delete the user, their
            expert profiles, company memberships, and WorkOS identity.
          </DialogDescription>
        </DialogHeader>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            backgroundColor: 'hsl(var(--destructive) / 0.1)',
            border: '1px solid hsl(var(--destructive) / 0.3)',
          }}
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{userEmail}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete User'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
