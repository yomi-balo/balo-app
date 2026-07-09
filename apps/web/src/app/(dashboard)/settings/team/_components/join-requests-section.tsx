'use client';

import { useCallback, useState } from 'react';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import type { PendingJoinRequestRow, ResolvedJoinRequestRow } from '@balo/db';
import { SectionCard, SectionEmpty, InfoNote } from '@/components/balo/domain-join/section-states';
import { RequestRow } from './request-row';
import { ResolvedDisclosure } from './resolved-disclosure';
import { approveJoinRequest } from '../_actions/approve-join-request';
import { declineJoinRequest } from '../_actions/decline-join-request';

type JoinMode = 'auto' | 'request' | 'off';

interface JoinRequestsSectionProps {
  mode: JoinMode;
  pending: ReadonlyArray<PendingJoinRequestRow>;
  resolved: ReadonlyArray<ResolvedJoinRequestRow>;
}

const MODE_LABEL: Record<Exclude<JoinMode, 'request'>, string> = {
  auto: 'Automatic',
  off: 'Off',
};

/**
 * The company join-request queue (BAL-347). Optimistic approve/decline: the row is
 * removed immediately (moving to Resolved once the action's `revalidatePath` refreshes
 * the RSC); on `{ success: false }` it is RESTORED in place with a shake + inline error
 * + `toast.error`. Reuses the existing approve/decline Server Actions unchanged. When
 * the mode isn't "request", an InfoNote ties any still-waiting requests to the mode.
 */
export function JoinRequestsSection({
  mode,
  pending,
  resolved,
}: Readonly<JoinRequestsSectionProps>): React.JSX.Element {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [errorIds, setErrorIds] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const visiblePending = pending.filter((request) => !hiddenIds.has(request.id));

  const resolve = useCallback(async (id: string, kind: 'approve' | 'decline'): Promise<void> => {
    setErrorIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setHiddenIds((prev) => new Set(prev).add(id));
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const result =
        kind === 'approve'
          ? await approveJoinRequest({ requestId: id })
          : await declineJoinRequest({ requestId: id });
      if (result.success) {
        toast.success(kind === 'approve' ? 'Request approved' : 'Request declined');
      } else {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setErrorIds((prev) => new Set(prev).add(id));
        toast.error(result.error);
      }
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const handleApprove = useCallback(
    (id: string) => {
      resolve(id, 'approve').catch(() => undefined);
    },
    [resolve]
  );
  const handleDecline = useCallback(
    (id: string) => {
      resolve(id, 'decline').catch(() => undefined);
    },
    [resolve]
  );

  const showModeNote = mode !== 'request' && visiblePending.length > 0;

  const headerRight =
    visiblePending.length > 0 ? (
      <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 text-xs font-bold">
        {visiblePending.length} waiting
      </span>
    ) : undefined;

  return (
    <SectionCard
      title="Join requests"
      description="People asking to join by domain. Approve to add them to your workspace."
      headerRight={headerRight}
    >
      {showModeNote && (
        <div className="mb-3.5">
          <InfoNote>
            Join mode is set to <strong>{MODE_LABEL[mode]}</strong>, so new requests won&apos;t
            arrive. Any requests still waiting below need a decision.
          </InfoNote>
        </div>
      )}

      {visiblePending.length === 0 ? (
        <SectionEmpty
          icon={Check}
          title="You're all caught up"
          body="No one is waiting to join right now. New requests will appear here for you to approve."
        />
      ) : (
        <div>
          {visiblePending.map((request, index) => (
            <div key={request.id} className={index === 0 ? undefined : 'border-border border-t'}>
              <RequestRow
                request={request}
                hasError={errorIds.has(request.id)}
                disabled={busyIds.has(request.id)}
                onApprove={handleApprove}
                onDecline={handleDecline}
              />
            </div>
          ))}
        </div>
      )}

      <ResolvedDisclosure resolved={resolved} />
    </SectionCard>
  );
}
