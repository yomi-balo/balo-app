'use client';

import { useState } from 'react';
import { Plus, Briefcase } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { WorkHistoryCard } from '@/app/(apply)/expert/apply/_components/work-history-card';
import { WorkHistoryForm } from '@/app/(apply)/expert/apply/_components/work-history-form';
import { saveWorkHistoryAction } from '../_actions/save-work-history';
import type { WorkHistory } from '@balo/db';

interface WorkHistoryEntry {
  id?: string;
  role: string;
  company: string;
  startedAt: string;
  endedAt?: string;
  isCurrent: boolean;
  responsibilities?: string;
}

interface WorkHistoryTabProps {
  initialEntries: WorkHistory[];
}

export function WorkHistoryTab({
  initialEntries,
}: Readonly<WorkHistoryTabProps>): React.JSX.Element {
  const [entries, setEntries] = useState<WorkHistoryEntry[]>(
    initialEntries.map((e) => ({
      id: e.id,
      role: e.role,
      company: e.company,
      startedAt: e.startedAt.toISOString().slice(0, 10),
      endedAt: e.endedAt?.toISOString().slice(0, 10),
      isCurrent: e.isCurrent,
      responsibilities: e.responsibilities ?? undefined,
    }))
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const handleEdit = (id: string): void => {
    setEditingId(id);
    setIsAdding(false);
  };

  const handleDelete = (id: string): void => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setEditingId(null);
    setIsDirty(true);
  };

  const handleSaveEntry = (entry: WorkHistoryEntry): void => {
    if (editingId) {
      setEntries((prev) => prev.map((e) => (e.id === editingId ? { ...entry, id: editingId } : e)));
      setEditingId(null);
    } else {
      // New entry
      setEntries((prev) => [...prev, { ...entry, id: `temp-${Date.now()}` }]);
      setIsAdding(false);
    }
    setIsDirty(true);
  };

  const handleCancel = (): void => {
    setEditingId(null);
    setIsAdding(false);
  };

  const handleSaveAll = async (): Promise<void> => {
    setIsSaving(true);
    try {
      const result = await saveWorkHistoryAction({
        entries: entries.map((e) => ({
          role: e.role,
          company: e.company,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          isCurrent: e.isCurrent,
          responsibilities: e.responsibilities,
        })),
      });

      if (result.success) {
        toast.success('Work history saved');
        setIsDirty(false);
      } else {
        toast.error(result.error ?? 'Failed to save work history');
      }
    } catch {
      toast.error('Failed to save work history. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      {entries.length === 0 && !isAdding ? (
        <div className="border-border rounded-xl border-2 border-dashed p-12 text-center">
          <Briefcase className="text-muted-foreground mx-auto mb-3 h-8 w-8" />
          <p className="text-muted-foreground text-sm">No work history entries yet.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setIsAdding(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add position
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <AnimatePresence mode="popLayout">
              {entries.map((entry) =>
                editingId === entry.id ? (
                  <WorkHistoryForm
                    key={entry.id}
                    initialData={entry}
                    onSave={handleSaveEntry}
                    onCancel={handleCancel}
                  />
                ) : (
                  <WorkHistoryCard
                    key={entry.id}
                    entry={entry}
                    onEdit={() => handleEdit(entry.id!)}
                    onDelete={() => handleDelete(entry.id!)}
                  />
                )
              )}
            </AnimatePresence>
          </div>

          {isAdding ? (
            <WorkHistoryForm onSave={handleSaveEntry} onCancel={handleCancel} />
          ) : (
            <Button
              type="button"
              variant="outline"
              className="text-primary w-full border-dashed"
              onClick={() => {
                setIsAdding(true);
                setEditingId(null);
              }}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add position
            </Button>
          )}
        </>
      )}

      {/* Save button */}
      {entries.length > 0 && (
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            onClick={handleSaveAll}
            disabled={!isDirty || isSaving}
            className="from-primary w-full bg-gradient-to-r to-violet-600 text-white sm:w-auto"
          >
            {isSaving ? 'Saving...' : 'Save work history'}
          </Button>
        </div>
      )}
    </div>
  );
}
