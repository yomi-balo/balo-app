'use client';

import { useCallback, useState } from 'react';
import { Ban } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cancelEngagementAction } from '@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement';
import { CancelEngagementModal } from './cancel-engagement-modal';
import { useEngagementLifecycleAction } from './use-engagement-lifecycle-action';

interface AdminCancelButtonProps {
  engagementId: string;
}

/**
 * The admin "Cancel engagement" danger affordance inside the {@link AdminOversightStrip}
 * (BAL-334 / D4). The strip renders only for the admin lens on active |
 * pending_acceptance engagements — i.e. exactly the cancellable states — so this button
 * can always render when the strip does. Confirming (with a required reason) calls
 * `cancelEngagementAction`.
 */
export function AdminCancelButton({
  engagementId,
}: Readonly<AdminCancelButtonProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [modalOpen, setModalOpen] = useState(false);

  const openModal = useCallback((): void => setModalOpen(true), []);
  const closeModal = useCallback((): void => setModalOpen(false), []);
  const handleConfirm = useCallback(
    (reason: string): void => {
      setModalOpen(false);
      run(cancelEngagementAction({ engagementId, reason }), 'Engagement cancelled');
    },
    [run, engagementId]
  );

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        type="button"
        onClick={openModal}
        disabled={isPending}
        className="ml-auto"
      >
        <Ban className="size-3.5" aria-hidden />
        Cancel engagement
      </Button>

      <CancelEngagementModal
        open={modalOpen}
        pending={isPending}
        onConfirm={handleConfirm}
        onCancel={closeModal}
      />
    </>
  );
}
