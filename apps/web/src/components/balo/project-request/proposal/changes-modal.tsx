'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { requestProposalChangesAction } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-changes';

/** The DB `proposalChangeSectionEnum` value space — must stay in lockstep with the action's Zod enum. */
type ChangeSection = 'general' | 'milestones' | 'pricing' | 'payment_terms' | 'timeline';

/** Data-driven section options — friendly labels for the five enum values (default `general`). */
const SECTION_OPTIONS: ReadonlyArray<{ value: ChangeSection; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'milestones', label: 'Milestones / deliverables' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'payment_terms', label: 'Payment terms' },
  { value: 'timeline', label: 'Timeline' },
];

const DEFAULT_SECTION: ChangeSection = 'general';

interface ChangesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  relationshipId: string;
  proposalId: string;
  /** Used to frame the copy ("Request changes from {name}"). */
  expertFirstName: string;
}

/**
 * The request-changes beat (A6.4 / BAL-290) — the CLIENT's lighter sibling of the
 * {@link AcceptConfirmModal}. Instead of the binding accept, the client picks a
 * section (default `general`) and writes a required note; on submit it calls
 * `requestProposalChangesAction`, which advances the current proposal
 * `submitted → changes_requested` and notifies the expert to revise & resubmit.
 *
 * Unlike accept, a change request isn't binding — so Escape / overlay may close it
 * (no pending hard-block). Owns its section + note + pending state; resets to the
 * defaults each time it reopens. Fires analytics on success, toasts on both arms.
 */
export function ChangesModal({
  open,
  onOpenChange,
  requestId,
  relationshipId,
  proposalId,
  expertFirstName,
}: Readonly<ChangesModalProps>): React.JSX.Element {
  const router = useRouter();
  const [section, setSection] = useState<ChangeSection>(DEFAULT_SECTION);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  // Reset to a clean slate whenever the modal reopens (covers proposal switch and
  // reuse for the next request) — never carry a stale section/note across opens.
  useEffect(() => {
    if (open) {
      setSection(DEFAULT_SECTION);
      setNote('');
    }
  }, [open]);

  const canSubmit = note.trim().length > 0;

  const handleSectionChange = useCallback((value: string): void => {
    setSection(value as ChangeSection);
  }, []);

  const handleSubmit = useCallback((): void => {
    if (pending || !canSubmit) return;
    setPending(true);

    const run = async (): Promise<void> => {
      try {
        const result = await requestProposalChangesAction({
          requestId,
          relationshipId,
          proposalId,
          section,
          note: note.trim(),
        });

        if (!result.success) {
          toast.error(result.error);
          return;
        }

        track(PROJECT_EVENTS.CHANGES_REQUESTED, {
          request_id: requestId,
          relationship_id: relationshipId,
          expert_id: result.expertProfileId,
          section,
          actor: 'client',
        });

        toast.success(`Change request sent to ${expertFirstName}`);
        onOpenChange(false);
        router.refresh();
      } catch {
        toast.error('Could not send your change request. Please try again.');
      } finally {
        setPending(false);
      }
    };
    run();
  }, [
    pending,
    canSubmit,
    requestId,
    relationshipId,
    proposalId,
    section,
    note,
    expertFirstName,
    onOpenChange,
    router,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!pending} className="gap-0 p-0 sm:max-w-[460px]">
        <DialogHeader className="from-warning/[0.1] to-warning/[0.03] border-border space-y-0 border-b bg-gradient-to-br p-6 text-left">
          <div className="flex items-center gap-3">
            <span className="bg-warning/15 text-warning flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
              <RotateCcw className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">
                Request changes from {expertFirstName}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {expertFirstName} will revise and resubmit as a new version. Your other proposal
                isn&apos;t affected.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="changes-section">What needs work?</Label>
            <Select value={section} onValueChange={handleSectionChange} disabled={pending}>
              <SelectTrigger id="changes-section" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="changes-note">Your note</Label>
            <Textarea
              id="changes-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={pending}
              rows={4}
              placeholder={`Tell ${expertFirstName} what you'd like changed…`}
              className="min-h-24 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="border-border border-t p-6 pt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Cancel
          </Button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || pending}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            )}
            Send request
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
