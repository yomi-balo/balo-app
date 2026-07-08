'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

/** The descriptive fields the expert can set — plain text only (no commercial axis). */
export interface MilestoneFormValues {
  title: string;
  descriptionText: string;
  acceptanceCriteria: string;
}

/** Edit-mode prefill — plain text sourced from `MilestoneNodeView` (never HTML). */
export interface MilestoneFormInitial {
  title: string;
  descriptionText: string | null;
  acceptanceCriteria: string | null;
}

interface MilestoneFormModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  /** Prefill for `edit`; `null` for a fresh `add`. */
  initial: MilestoneFormInitial | null;
  clientCompanyName: string;
  pending: boolean;
  onConfirm: (values: MilestoneFormValues) => void;
  onCancel: () => void;
}

const TITLE_FIELD_ID = 'milestone-form-title';
const DESCRIPTION_FIELD_ID = 'milestone-form-description';
const CRITERIA_FIELD_ID = 'milestone-form-criteria';

const EMPTY_VALUES: MilestoneFormValues = {
  title: '',
  descriptionText: '',
  acceptanceCriteria: '',
};

/**
 * The add / edit milestone form dialog (BAL-333 / D3) — descriptive fields ONLY. Title
 * (required), Description (optional → plain text), and "Done when…" (optional →
 * acceptance criteria). The price-lock notice makes the D3 hard line visible: the plan
 * is descriptive, the price is fixed from the accepted proposal. Blocks close while
 * `pending` (`onOpenChange` no-ops, the close button is hidden — mirrors the D2 modals);
 * the primary CTA stays disabled until the title is non-empty and shows a spinner in
 * flight. `estimated_minutes` is intentionally NOT surfaced (design omits it).
 */
export function MilestoneFormModal({
  open,
  mode,
  initial,
  clientCompanyName,
  pending,
  onConfirm,
  onCancel,
}: Readonly<MilestoneFormModalProps>): React.JSX.Element {
  const [values, setValues] = useState<MilestoneFormValues>(EMPTY_VALUES);

  // Seed the fields from `initial` each time the dialog opens (fresh per target).
  useEffect(() => {
    if (!open) return;
    setValues(
      initial === null
        ? EMPTY_VALUES
        : {
            title: initial.title,
            descriptionText: initial.descriptionText ?? '',
            acceptanceCriteria: initial.acceptanceCriteria ?? '',
          }
    );
  }, [open, initial]);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending) return; // no close mid-flight
      if (!next) onCancel();
    },
    [pending, onCancel]
  );

  const setField = useCallback(
    (field: keyof MilestoneFormValues) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
        const { value } = event.target;
        setValues((prev) => ({ ...prev, [field]: value }));
      },
    []
  );

  const handleConfirm = useCallback((): void => {
    onConfirm(values);
  }, [onConfirm, values]);

  const isAdd = mode === 'add';
  const canSubmit = values.title.trim() !== '' && !pending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{isAdd ? 'Add milestone' : 'Edit milestone'}</DialogTitle>
          <DialogDescription>
            {isAdd
              ? 'Add a milestone to the delivery plan so progress stays visible.'
              : 'Update the milestone — commercial terms stay fixed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={TITLE_FIELD_ID}>Title</Label>
            <Input
              id={TITLE_FIELD_ID}
              value={values.title}
              maxLength={200}
              disabled={pending}
              onChange={setField('title')}
              placeholder="e.g. Data migration dry-run"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={DESCRIPTION_FIELD_ID}>Description (optional)</Label>
            <Textarea
              id={DESCRIPTION_FIELD_ID}
              rows={2}
              maxLength={10_000}
              value={values.descriptionText}
              disabled={pending}
              onChange={setField('descriptionText')}
              placeholder="What this milestone covers"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={CRITERIA_FIELD_ID}>Done when… (optional)</Label>
            <p className="text-muted-foreground text-xs leading-relaxed">
              The acceptance criteria {clientCompanyName} can check against.
            </p>
            <Textarea
              id={CRITERIA_FIELD_ID}
              rows={2}
              maxLength={2_000}
              value={values.acceptanceCriteria}
              disabled={pending}
              onChange={setField('acceptanceCriteria')}
              placeholder="How you'll both know it's delivered"
            />
          </div>

          {/* The D3 hard line, visible in the design: descriptive only. */}
          <div className="bg-muted flex gap-2 rounded-lg px-3 py-2.5">
            <AlertCircle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {clientCompanyName} is notified of plan changes. The project price can&rsquo;t change
              here — pricing changes go through a new proposal.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="default" type="button" onClick={handleConfirm} disabled={!canSubmit}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Check className="size-4" aria-hidden />
            )}
            {isAdd ? 'Add milestone' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
