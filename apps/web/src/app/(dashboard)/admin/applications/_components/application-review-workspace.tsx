'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { editExpertApplicationAction } from '../_actions/edit-expert-application';
import {
  buildStaffEdit,
  describeStaffEditChanges,
  type StaffEditModel,
  type StaffEditReference,
} from '../_lib/staff-edit-model';
import { ApplicationEditForm } from './edit/application-edit-form';
import { EditSaveBar } from './edit/edit-save-bar';
import { DiscardChangesDialog } from './edit/discard-changes-dialog';
import { DecisionControls } from './decision-controls';

/**
 * BAL-593 — the review page's client shell. Toggles between the SHIPPED read-only sections
 * (`readSections`, built server-side) and the staff edit surface (`ApplicationEditForm`, package
 * F), and owns the save/cancel/discard flow and the unsaved-changes guard.
 *
 * ⚠ RECEIVES NO FULL APPLICATION SHAPE. `readSections` / `banner` / `workHistory` are already
 * RENDERED server-side `React.ReactNode`s — this component never sees `declineNote` or anything
 * else the page withholds from a non-reviewer. `editModel` / `reference` are the client-safe
 * staff-edit view model (`@/_lib/staff-edit-model`), never the raw DB row.
 *
 * ⚠ AC 8 — APPROVE/DECLINE AND "EDIT APPLICATION" ARE MUTUALLY EXCLUSIVE. While `editing`,
 * `DecisionControls` is not rendered AT ALL (not merely disabled) — re-resolving the decision
 * while a staff edit is in flight would race the SAME locked-row transaction `editApplicationAsStaff`
 * and `decideApplication` both take (H5).
 */

interface ApplicationReviewWorkspaceProps {
  readonly expertProfileId: string;
  readonly firstName: string;
  readonly isPending: boolean;
  readonly canEdit: boolean;
  readonly live: boolean;
  readonly headerSummary: React.ReactNode;
  readonly banner: React.ReactNode;
  readonly readSections: React.ReactNode;
  readonly workHistory: React.ReactNode;
  readonly editModel: StaffEditModel | null;
  readonly reference: StaffEditReference | null;
}

export function ApplicationReviewWorkspace({
  expertProfileId,
  firstName,
  isPending,
  canEdit,
  live,
  headerSummary,
  banner,
  readSections,
  workHistory,
  editModel,
  reference,
}: Readonly<ApplicationReviewWorkspaceProps>): React.JSX.Element {
  const router = useRouter();
  const [draft, setDraft] = useState<StaffEditModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);

  const editing = draft !== null;

  const changes = useMemo(() => {
    if (draft === null || editModel === null || reference === null) return [];
    return describeStaffEditChanges(editModel, draft, reference);
  }, [draft, editModel, reference]);

  const handleAttemptLeave = useCallback((href: string): void => {
    setPendingHref(href);
    setDiscardOpen(true);
  }, []);

  useUnsavedChangesGuard(editing && changes.length > 0, handleAttemptLeave);

  const handleStartEdit = useCallback((): void => {
    if (editModel === null) return;
    setChangesOpen(false);
    setDraft(editModel);
  }, [editModel]);

  const handleToggleChanges = useCallback((): void => {
    setChangesOpen((open) => !open);
  }, []);

  const handleCancel = useCallback((): void => {
    if (changes.length > 0) {
      setDiscardOpen(true);
      return;
    }
    setDraft(null);
  }, [changes.length]);

  const handleKeepEditing = useCallback((): void => {
    setDiscardOpen(false);
  }, []);

  const handleDiscard = useCallback((): void => {
    setDiscardOpen(false);
    setChangesOpen(false);
    setDraft(null);
    if (pendingHref !== null) router.push(pendingHref);
    setPendingHref(null);
  }, [pendingHref, router]);

  const handleSave = useCallback((): void => {
    if (draft === null || editModel === null || saving || changes.length === 0) return;
    setSaving(true);

    const run = async (): Promise<void> => {
      try {
        const result = await editExpertApplicationAction({
          expertProfileId,
          edit: buildStaffEdit(editModel, draft),
        });

        if (!result.success) {
          if (result.code === 'not_editable') {
            setDraft(null);
            setChangesOpen(false);
            // pending-MJ
            toast.error(
              `${firstName}’s application was declined while you were editing. Nothing was saved.`
            );
            router.refresh();
            return;
          }
          toast.error(result.error);
          if (result.code === 'gone') router.refresh();
          return;
        }

        if (result.changed) {
          track(ADMIN_APPLICATIONS_EVENTS.EDITED, result.analytics);
          // pending-MJ
          toast.success(
            result.live
              ? `Changes saved. ${firstName}’s profile is updated and they’ve been emailed.`
              : 'Changes saved'
          );
        } else {
          toast.success('No changes to save'); // pending-MJ
        }
        setDraft(null);
        setChangesOpen(false);
        router.refresh();
      } catch {
        // pending-MJ
        toast.error('Couldn’t save the changes. Nothing was written, so try again.');
      } finally {
        setSaving(false);
      }
    };
    run();
  }, [draft, editModel, saving, changes.length, expertProfileId, firstName, router]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {headerSummary}
        {editing ? (
          <div className="max-w-[260px] text-right">
            <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold">
              <Pencil className="size-3" aria-hidden="true" />
              {/* pending-MJ */}
              Editing
            </span>
            {isPending && (
              <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                {/* pending-MJ */}
                Approve and Decline come back when you save or cancel.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="outline" onClick={handleStartEdit}>
                <Pencil className="size-4" aria-hidden="true" />
                {/* pending-MJ */}
                Edit application
              </Button>
            )}
            {isPending && (
              <DecisionControls expertProfileId={expertProfileId} firstName={firstName} />
            )}
          </div>
        )}
      </div>

      {banner}

      {editing && editModel !== null && draft !== null && reference !== null ? (
        <>
          <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">Application</legend>
            <ApplicationEditForm
              initial={editModel}
              draft={draft}
              onChange={setDraft}
              reference={reference}
              disabled={saving}
            />
          </fieldset>
          <div>
            {/* pending-MJ */}
            <p className="text-muted-foreground mb-2 text-xs">Not editable here</p>
            <div className="opacity-70">{workHistory}</div>
          </div>
          <EditSaveBar
            changes={changes}
            saving={saving}
            live={live}
            firstName={firstName}
            open={changesOpen}
            onToggle={handleToggleChanges}
            onCancel={handleCancel}
            onSave={handleSave}
          />
          <DiscardChangesDialog
            open={discardOpen}
            count={changes.length}
            firstName={firstName}
            onKeep={handleKeepEditing}
            onDiscard={handleDiscard}
          />
        </>
      ) : (
        <>
          {readSections}
          {workHistory}
        </>
      )}
    </div>
  );
}
