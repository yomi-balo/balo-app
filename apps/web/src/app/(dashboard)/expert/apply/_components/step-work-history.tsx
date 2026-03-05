'use client';

import { useEffect, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Briefcase } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { workHistoryStepSchema, type WorkHistoryStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { WorkHistoryCard } from './work-history-card';
import { WorkHistoryForm } from './work-history-form';

interface StepWorkHistoryProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

interface WorkEntry {
  id?: string;
  role: string;
  company: string;
  startedAt: string;
  endedAt?: string;
  isCurrent: boolean;
  responsibilities?: string;
}

export function StepWorkHistory({ headingRef }: Readonly<StepWorkHistoryProps>): React.JSX.Element {
  const { workHistoryData, updateStepData, registerValidation } = useWizard();
  const [showForm, setShowForm] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

  const form = useForm<WorkHistoryStepData>({
    resolver: zodResolver(workHistoryStepSchema),
    defaultValues: {
      entries: workHistoryData.entries ?? [],
    },
    mode: 'onSubmit',
  });

  const entries = form.watch('entries') ?? [];

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('work-history', values);
    });
    return () => subscription.unsubscribe();
  }, [form, updateStepData]);

  // Register validation (optional step, always passes)
  const validate = useCallback(async (): Promise<boolean> => {
    return form.trigger();
  }, [form]);

  useEffect(() => {
    registerValidation(validate);
  }, [registerValidation, validate]);

  const handleSave = (entry: WorkEntry): void => {
    const current = form.getValues('entries') ?? [];
    if (editIndex === null) {
      form.setValue('entries', [...current, entry], { shouldDirty: true });
    } else {
      const updated = [...current];
      updated[editIndex] = entry;
      form.setValue('entries', updated, { shouldDirty: true });
    }
    setShowForm(false);
    setEditIndex(null);
  };

  const handleEdit = (index: number): void => {
    setEditIndex(index);
    setShowForm(true);
  };

  const handleDelete = (): void => {
    if (deleteIndex === null) return;
    const current = form.getValues('entries') ?? [];
    form.setValue(
      'entries',
      current.filter((_, i) => i !== deleteIndex),
      { shouldDirty: true }
    );
    setDeleteIndex(null);
  };

  const handleCancel = (): void => {
    setShowForm(false);
    setEditIndex(null);
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-xl font-semibold outline-none"
        >
          Work Experience
        </h2>
        <p className="text-muted-foreground -mt-2 text-sm">
          Add your relevant consulting and Salesforce experience. This is optional but helps clients
          understand your background.
        </p>

        {entries.length === 0 && !showForm ? (
          <div className="border-border rounded-xl border-2 border-dashed p-8 text-center">
            <div className="bg-muted mx-auto mb-3 w-fit rounded-xl p-3">
              <Briefcase className="text-muted-foreground h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-foreground text-sm font-semibold">No experience added yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Share your Salesforce journey to build trust with clients.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => setShowForm(true)}
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add Experience
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {entries.map((entry, index) => (
                <WorkHistoryCard
                  key={entry.id ?? `entry-${index}`}
                  entry={entry}
                  onEdit={() => handleEdit(index)}
                  onDelete={() => setDeleteIndex(index)}
                />
              ))}
            </AnimatePresence>

            {!showForm && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditIndex(null);
                  setShowForm(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                Add Experience
              </Button>
            )}

            {entries.length >= 1 && !showForm && (
              <p className="text-muted-foreground mt-2 text-xs">
                {entries.length >= 3
                  ? "That's a solid track record."
                  : 'Looking good! Add your most impressive role first -- it appears at the top of your profile.'}
              </p>
            )}
          </div>
        )}

        {/* Inline form */}
        <AnimatePresence>
          {showForm && (
            <WorkHistoryForm
              initialData={editIndex === null ? undefined : entries[editIndex]}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          )}
        </AnimatePresence>

        {/* Delete confirmation dialog */}
        <Dialog open={deleteIndex !== null} onOpenChange={() => setDeleteIndex(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove this experience?</DialogTitle>
            </DialogHeader>
            <p className="text-muted-foreground text-sm">
              This will permanently remove this entry from your application.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleteIndex(null)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={handleDelete}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </form>
    </Form>
  );
}
