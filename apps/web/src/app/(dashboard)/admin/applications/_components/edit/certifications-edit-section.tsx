'use client';

import { Award, X, Undo2 } from 'lucide-react';
import type { CertificationsByCategory } from '@balo/db';
import { Button } from '@/components/ui/button';
import { AddPicker, type AddPickerGroup } from './add-picker';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — certifications: a grid of cards (present / struck "Removed when you save" with
 * Undo / "New") and an add-picker grouped by category. Design ref 1842-1949.
 *
 * The design reference also shows a read-only "Check against Trailhead" link here, keyed off
 * `trailheadUrl`. It's omitted: `StaffEditModel` carries no `trailheadUrl` field, so this
 * section has no data channel for it. The link remains visible on the page's read-only
 * `ApplicationSections` view.
 */

export interface CertificationsEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly certificationsByCategory: readonly CertificationsByCategory[];
  readonly disabled: boolean;
}

export function CertificationsEditSection({
  draft,
  initial,
  update,
  certificationsByCategory,
  disabled,
}: Readonly<CertificationsEditSectionProps>): React.JSX.Element {
  const certMeta = new Map(
    certificationsByCategory.flatMap((cat) =>
      cat.certifications.map((c) => [c.id, { name: c.name, category: cat.category.name }] as const)
    )
  );
  const catalogueOrder = certificationsByCategory.flatMap((cat) =>
    cat.certifications.map((c) => c.id)
  );
  const shown = catalogueOrder.filter(
    (id) => draft.certificationIds.includes(id) || initial.certificationIds.includes(id)
  );

  const addCert = (id: string): void => {
    update((d) => ({ ...d, certificationIds: [...d.certificationIds, id] }));
  };
  const removeCert = (id: string): void => {
    update((d) => ({ ...d, certificationIds: d.certificationIds.filter((x) => x !== id) }));
  };

  const availableGroups: AddPickerGroup[] = certificationsByCategory
    .map((cat) => ({
      heading: cat.category.name,
      items: cat.certifications
        .filter((c) => !draft.certificationIds.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name })),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
            <Award className="text-muted-foreground size-3.5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Certifications
          </p>
        </div>
        <AddPicker
          label="Add certification"
          groups={availableGroups}
          onPick={addCert}
          disabled={disabled}
        />
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No certifications yet — add the ones this expert holds.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {shown.map((id) => {
            const meta = certMeta.get(id);
            const name = meta?.name ?? id;
            const present = draft.certificationIds.includes(id);
            const isNew = present && !initial.certificationIds.includes(id);
            const presentCardClass = isNew
              ? ' border-border bg-card border ring-primary ring-1'
              : ' border-border bg-card border';
            const cardClass = present
              ? presentCardClass
              : ' border-border bg-background border border-dashed';
            return (
              <div
                key={id}
                className={
                  'flex min-h-[58px] items-center gap-3 rounded-xl px-3.5 py-2.5' + cardClass
                }
              >
                <Award
                  className={
                    present
                      ? 'text-warning size-4 shrink-0'
                      : 'text-muted-foreground size-4 shrink-0'
                  }
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={
                      present
                        ? 'text-foreground text-sm font-semibold'
                        : 'text-muted-foreground text-sm font-semibold'
                    }
                  >
                    {present ? name : <s>{name}</s>}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-[11.5px]">
                    {present ? meta?.category : 'Removed when you save'}
                  </p>
                </div>
                {isNew && (
                  <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10.5px] font-semibold">
                    New
                  </span>
                )}
                {present ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`Remove ${name}`}
                    onClick={() => removeCert(id)}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Undo removing ${name}`}
                    onClick={() => addCert(id)}
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Undo
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
