'use client';

import { Briefcase } from 'lucide-react';
import { PROJECT_COUNT_RANGES } from '@balo/shared/experts';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ChangedDot } from './changed-dot';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — the Experience section's editable scalars: year started and the two
 * project-count ranges. Design ref 1380-1465.
 *
 * The design reference also shows a read-only "LinkedIn → View profile" row here. It's omitted:
 * neither `StaffEditModel['experience']` nor `ApplicationEditFormProps` carries `linkedinUrl`, so
 * this section has no data channel to render it from. The link remains visible on the page's
 * read-only `ApplicationSections` view, which the workspace renders beside/above the edit form.
 */

const CURRENT_YEAR = new Date().getFullYear();

function Field({
  label,
  htmlFor,
  changed,
  children,
}: Readonly<{
  label: string;
  htmlFor?: string;
  changed: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 text-sm">
      <Label
        htmlFor={htmlFor}
        className="text-muted-foreground flex items-center gap-1.5 font-normal"
      >
        {changed && <ChangedDot />}
        {label}
      </Label>
      <div className="text-foreground font-medium">{children}</div>
    </div>
  );
}

export interface ExperienceEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly disabled: boolean;
}

export function ExperienceEditSection({
  draft,
  initial,
  update,
  disabled,
}: Readonly<ExperienceEditSectionProps>): React.JSX.Element {
  const exp = draft.experience;

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
          <Briefcase className="text-muted-foreground size-3.5" aria-hidden="true" />
        </div>
        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          Experience
        </p>
      </div>
      <div className="border-border bg-card grid grid-cols-1 gap-x-8 gap-y-1 rounded-xl border p-5 sm:grid-cols-2">
        <Field
          label="Year started"
          htmlFor="staff-edit-year-started"
          changed={exp.yearStartedSalesforce !== initial.experience.yearStartedSalesforce}
        >
          <Input
            id="staff-edit-year-started"
            type="number"
            inputMode="numeric"
            min={2000}
            max={CURRENT_YEAR}
            disabled={disabled}
            className="h-8 w-24 text-right"
            value={exp.yearStartedSalesforce ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              update((d) => ({
                ...d,
                experience: {
                  ...d.experience,
                  yearStartedSalesforce: raw === '' ? null : Number(raw),
                },
              }));
            }}
          />
        </Field>
        <Field
          label="Projects involved in"
          htmlFor="staff-edit-project-count"
          changed={exp.projectCountMin !== initial.experience.projectCountMin}
        >
          <Select
            value={String(exp.projectCountMin ?? 0)}
            disabled={disabled}
            onValueChange={(value) =>
              update((d) => ({
                ...d,
                experience: { ...d.experience, projectCountMin: Number(value) },
              }))
            }
          >
            <SelectTrigger id="staff-edit-project-count" size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_COUNT_RANGES.map((range) => (
                <SelectItem key={range.min} value={String(range.min)}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Projects as lead"
          htmlFor="staff-edit-project-lead-count"
          changed={exp.projectLeadCountMin !== initial.experience.projectLeadCountMin}
        >
          <Select
            value={String(exp.projectLeadCountMin ?? 0)}
            disabled={disabled}
            onValueChange={(value) =>
              update((d) => ({
                ...d,
                experience: { ...d.experience, projectLeadCountMin: Number(value) },
              }))
            }
          >
            <SelectTrigger id="staff-edit-project-lead-count" size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_COUNT_RANGES.map((range) => (
                <SelectItem key={range.min} value={String(range.min)}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </section>
  );
}
