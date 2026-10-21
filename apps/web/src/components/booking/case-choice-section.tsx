'use client';

import { FilePlus2, FolderOpen } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelativeDate, pluralizeConsultations } from './format';
import type { OpenCaseForExpert } from './types';

const NEW_CASE_VALUE = '__new__';
const FIELD_ID = 'booking-case-choice';

interface CaseOptionProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}

function CaseOption({ icon, title, subtitle }: Readonly<CaseOptionProps>): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-3 text-left">
      {icon}
      <span className="min-w-0">
        <span className="text-foreground block truncate text-sm font-semibold">{title}</span>
        <span className="text-muted-foreground block truncate text-xs leading-snug">
          {subtitle}
        </span>
      </span>
    </span>
  );
}

const NEW_CASE_ICON = (
  <span className="border-primary/25 bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
    <FilePlus2 className="text-primary h-4 w-4" aria-hidden="true" />
  </span>
);

const EXISTING_CASE_ICON = (
  <span className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
    <FolderOpen className="text-muted-foreground h-4 w-4" aria-hidden="true" />
  </span>
);

export interface CaseChoiceSectionProps {
  openCases: readonly OpenCaseForExpert[];
  /** `null` ⇒ "Start a new case". A `string` ⇒ that case's `engagementId`. */
  selectedEngagementId: string | null;
  onSelect: (engagementId: string | null) => void;
  expertFirstName: string | null;
  /** `false` lists open cases only — the expert has paused new work. Defaults to `true`. */
  offerNewCase?: boolean;
}

/**
 * BAL-400 §2.5 — the case choice, as ONE dropdown so the dialog stays the same height however
 * many open cases the client has with this expert. Absent from the tree entirely when there is
 * nothing to choose between (the caller decides that — see `step-confirm.tsx`).
 *
 * The trigger renders the selected option in full (icon, title, consultation count), so the
 * choice reads at a glance without opening the list.
 */
export function CaseChoiceSection({
  openCases,
  selectedEngagementId,
  onSelect,
  expertFirstName,
  offerNewCase = true,
}: Readonly<CaseChoiceSectionProps>): React.JSX.Element {
  const newCaseOption = (
    <CaseOption
      icon={NEW_CASE_ICON}
      title="Start a new case"
      subtitle={`For a new issue with ${expertFirstName ?? 'them'}.`}
    />
  );
  const optionFor = (c: OpenCaseForExpert): React.JSX.Element => (
    <CaseOption
      icon={EXISTING_CASE_ICON}
      title={c.title}
      subtitle={`${pluralizeConsultations(c.consultationCount)} · last activity ${formatRelativeDate(c.lastActivityAt)}`}
    />
  );
  const selectedCase =
    selectedEngagementId === null
      ? undefined
      : openCases.find((c) => c.engagementId === selectedEngagementId);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <label htmlFor={FIELD_ID} className="text-foreground text-sm font-semibold">
          Which case is this for?
        </label>
        <p className="text-muted-foreground text-xs leading-relaxed">
          A case can hold more than one consultation on the same issue.
        </p>
      </div>
      <Select
        value={selectedEngagementId ?? NEW_CASE_VALUE}
        onValueChange={(value) => onSelect(value === NEW_CASE_VALUE ? null : value)}
      >
        <SelectTrigger id={FIELD_ID} className="h-auto min-h-14 w-full px-3 py-2.5">
          <SelectValue>
            {selectedCase === undefined ? newCaseOption : optionFor(selectedCase)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          {offerNewCase && (
            <>
              <SelectItem value={NEW_CASE_VALUE} className="py-2">
                {newCaseOption}
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {openCases.map((c) => (
            <SelectItem key={c.engagementId} value={c.engagementId} className="py-2">
              {optionFor(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
