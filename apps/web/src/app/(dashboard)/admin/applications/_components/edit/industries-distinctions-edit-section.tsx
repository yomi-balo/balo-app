'use client';

import { Building2, Award, X, Check, Plus } from 'lucide-react';
import type { Industry } from '@balo/db';
import { Button } from '@/components/ui/button';
import { AddPicker } from './add-picker';
import { ChangedDot } from './changed-dot';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — industries (chips with remove/undo + an add-picker) and the three Salesforce
 * distinction toggles, side by side. Design ref 1568-1701.
 */

const DISTINCTIONS: readonly {
  key: 'isSalesforceMvp' | 'isSalesforceCta' | 'isCertifiedTrainer';
  label: string;
}[] = [
  { key: 'isSalesforceMvp', label: 'Salesforce MVP' },
  { key: 'isSalesforceCta', label: 'Salesforce CTA' },
  { key: 'isCertifiedTrainer', label: 'Certified Trainer' },
];

export interface IndustriesDistinctionsEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly industries: readonly Industry[];
  readonly disabled: boolean;
}

export function IndustriesDistinctionsEditSection({
  draft,
  initial,
  update,
  industries,
  disabled,
}: Readonly<IndustriesDistinctionsEditSectionProps>): React.JSX.Element {
  const industryById = new Map(industries.map((i) => [i.id, i]));
  const removedIndustries = initial.industryIds.filter((id) => !draft.industryIds.includes(id));

  const addIndustry = (id: string): void => {
    update((d) => ({ ...d, industryIds: [...d.industryIds, id] }));
  };
  const removeIndustry = (id: string): void => {
    update((d) => ({ ...d, industryIds: d.industryIds.filter((x) => x !== id) }));
  };
  const toggleDistinction = (key: (typeof DISTINCTIONS)[number]['key']): void => {
    update((d) => ({ ...d, experience: { ...d.experience, [key]: !d.experience[key] } }));
  };

  const available = [
    {
      heading: null,
      items: industries
        .filter((i) => !draft.industryIds.includes(i.id))
        .map((i) => ({ id: i.id, name: i.name })),
    },
  ];

  return (
    <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
              <Building2 className="text-muted-foreground size-3.5" aria-hidden="true" />
            </div>
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
              Industries
            </p>
          </div>
          <AddPicker
            label="Add industry"
            groups={available}
            onPick={addIndustry}
            disabled={disabled}
          />
        </div>
        {draft.industryIds.length === 0 && removedIndustries.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            None selected — add the industries this expert has worked in.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {draft.industryIds.map((id) => {
              const industry = industryById.get(id);
              const isNew = !initial.industryIds.includes(id);
              return (
                <span
                  key={id}
                  className="bg-muted text-foreground inline-flex h-7 items-center gap-1 rounded-full py-0.5 pr-1 pl-3 text-xs font-medium"
                >
                  {industry?.name ?? id}
                  {isNew && <span className="text-primary ml-1 text-[10.5px] font-bold">New</span>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    aria-label={`Remove ${industry?.name ?? id}`}
                    onClick={() => removeIndustry(id)}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </Button>
                </span>
              );
            })}
            {removedIndustries.map((id) => {
              const industry = industryById.get(id);
              const name = industry?.name ?? id;
              return (
                <span
                  key={id}
                  className="border-border text-muted-foreground inline-flex h-7 items-center gap-1 rounded-full border border-dashed py-0.5 pr-1 pl-3 text-xs"
                >
                  <s>{name}</s>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Undo removing ${name}`}
                    onClick={() => addIndustry(id)}
                  >
                    Undo
                  </Button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
            <Award className="text-muted-foreground size-3.5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Distinctions
          </p>
        </div>
        <div role="group" aria-label="Distinctions" className="flex flex-wrap gap-2">
          {DISTINCTIONS.map(({ key, label }) => {
            const on = draft.experience[key];
            const changed = on !== initial.experience[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggleDistinction(key)}
                className={
                  on
                    ? 'bg-warning/10 text-warning border-warning/30 inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50'
                    : 'bg-card text-muted-foreground border-border inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50'
                }
              >
                {changed && <ChangedDot />}
                {on ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <Plus className="size-3.5" aria-hidden="true" />
                )}
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
