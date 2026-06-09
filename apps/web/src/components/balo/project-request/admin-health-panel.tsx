'use client';

import { useCallback, useState, useTransition } from 'react';
import { Activity, AlertTriangle, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type {
  RelationshipState,
  RequestRelationshipView,
} from '@/lib/project-request/request-detail-view';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { removeInvitedExpertAction } from '@/app/(dashboard)/projects/[requestId]/_actions/remove-invited-expert';
import { RequestCard } from './request-card';
import { ExpertInviteDialog } from './expert-invite-dialog';

interface AdminHealthPanelProps {
  requestId: string;
  status: string;
  relationships: RequestRelationshipView[];
}

/** Per-relationship state label + accent for the pipeline list. */
const STATE_META: Record<RelationshipState, { label: string; tone: string }> = {
  invited: { label: 'Invited · awaiting EOI', tone: 'text-warning' },
  eoi_in: { label: 'EOI in · talking', tone: 'text-success' },
  proposal_requested: { label: 'Proposal requested', tone: 'text-primary' },
  proposal_in: { label: 'Proposal in', tone: 'text-primary' },
  accepted: { label: 'Accepted', tone: 'text-success' },
  declined: { label: 'Declined', tone: 'text-muted-foreground' },
};

/**
 * Statuses where admin invite/remove controls are live. Remove additionally
 * requires the row itself to still be `invited` (`rel.removable`). Mirrors the
 * design ref: controls render only for `experts_invited ≤ status < proposal_requested`.
 */
const INVITE_WINDOW_STATUSES = new Set<string>(['experts_invited', 'eoi_submitted']);

function deriveInitials(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/** Single removable row's remove button + its confirmation AlertDialog. */
function RemoveExpertButton({
  requestId,
  relationship,
}: Readonly<{ requestId: string; relationship: RequestRelationshipView }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleRemove = useCallback((): void => {
    startTransition(async () => {
      const result = await removeInvitedExpertAction({
        requestId,
        relationshipId: relationship.id,
      });
      if (result.success) {
        toast.success(`${relationship.expertName} removed.`);
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }, [requestId, relationship.id, relationship.expertName]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Remove ${relationship.expertName}`}
        className="border-border bg-card text-muted-foreground hover:border-destructive/40 hover:text-destructive flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {relationship.expertName}?</AlertDialogTitle>
            <AlertDialogDescription>
              They&apos;ll no longer see this request or be able to express interest. You can invite
              them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRemove();
              }}
              disabled={isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Observer "Pipeline health" panel — a live, per-expert list of the request's
 * relationships with derived state, a "Quiet N days" stall flag, and admin
 * invite-another / remove controls (A2 / BAL-269 wires these; A1 authored them as
 * disabled placeholders). Rendered only once the request has relationships (the
 * shell hides it before `experts_invited`).
 */
export function AdminHealthPanel({
  requestId,
  status,
  relationships,
}: Readonly<AdminHealthPanelProps>): React.JSX.Element {
  const [inviteOpen, setInviteOpen] = useState(false);
  const windowOpen = INVITE_WINDOW_STATUSES.has(status);
  // The picker pre-filters on expert_profiles ids, but the view-model intentionally
  // does not surface them (only relationship ids cross the boundary). Pass the empty
  // set; the invite action's unique-index dedup is the authoritative, idempotent
  // guard against re-inviting an already-invited expert.
  const invitedExpertProfileIds: string[] = [];

  return (
    <RequestCard className="p-5">
      <div className="text-info mb-3 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-[11px] font-bold tracking-wider uppercase">Pipeline health</span>
      </div>

      <ul className="flex flex-col gap-2">
        {relationships.map((rel) => {
          const meta = STATE_META[rel.state];
          const canRemove = rel.removable && windowOpen;
          return (
            <li
              key={rel.id}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5',
                rel.isQuiet ? 'border-warning/40 bg-warning/5' : 'border-border'
              )}
            >
              <span className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold">
                {deriveInitials(rel.expertName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{rel.expertName}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <p className={cn('text-xs font-medium', meta.tone)}>{meta.label}</p>
                  {rel.isQuiet && (
                    <span className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold">
                      <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
                      Quiet {rel.quietDays} days
                    </span>
                  )}
                </div>
              </div>
              {canRemove && <RemoveExpertButton requestId={requestId} relationship={rel} />}
            </li>
          );
        })}
      </ul>

      {windowOpen && (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="border-border text-muted-foreground hover:border-primary/40 hover:text-primary mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-sm font-medium transition-colors"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Invite another expert
        </button>
      )}

      <ExpertInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        requestId={requestId}
        alreadyInvitedIds={invitedExpertProfileIds}
      />
    </RequestCard>
  );
}
