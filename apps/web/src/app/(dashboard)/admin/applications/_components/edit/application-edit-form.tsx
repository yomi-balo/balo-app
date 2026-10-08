'use client';

import { ExperienceEditSection } from './experience-edit-section';
import { LanguagesEditSection } from './languages-edit-section';
import { IndustriesDistinctionsEditSection } from './industries-distinctions-edit-section';
import { ProductsEditSection } from './products-edit-section';
import { RatingsEditSection } from './ratings-edit-section';
import { CertificationsEditSection } from './certifications-edit-section';
import type { StaffEditModel, StaffEditReference } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — the editable application: the six sections, in page order. Design ref
 * 2590-2640 (the real page nests these inside its own `<fieldset disabled={saving}>`; this
 * component owns no fieldset of its own, since `disabled` here already covers both "saving" and
 * any other reason the caller wants the form frozen).
 *
 * Every section update goes through `onChange`, via a local `update` helper that takes a plain
 * function `(draft) => nextDraft` and applies it immutably — a spread at each touched level, no
 * new dependency (no immer).
 */
export interface ApplicationEditFormProps {
  readonly initial: StaffEditModel;
  readonly draft: StaffEditModel;
  readonly onChange: (next: StaffEditModel) => void;
  readonly reference: StaffEditReference;
  readonly disabled: boolean;
}

export function ApplicationEditForm({
  initial,
  draft,
  onChange,
  reference,
  disabled,
}: Readonly<ApplicationEditFormProps>): React.JSX.Element {
  const update = (fn: (draft: StaffEditModel) => StaffEditModel): void => {
    onChange(fn(draft));
  };

  return (
    <div className="flex flex-col gap-7">
      <ExperienceEditSection draft={draft} initial={initial} update={update} disabled={disabled} />
      <LanguagesEditSection
        draft={draft}
        initial={initial}
        update={update}
        languages={reference.languages}
        disabled={disabled}
      />
      <IndustriesDistinctionsEditSection
        draft={draft}
        initial={initial}
        update={update}
        industries={reference.industries}
        disabled={disabled}
      />
      <ProductsEditSection
        draft={draft}
        initial={initial}
        update={update}
        productsByCategory={reference.productsByCategory}
        supportTypes={reference.supportTypes}
        disabled={disabled}
      />
      <RatingsEditSection
        draft={draft}
        initial={initial}
        update={update}
        productsByCategory={reference.productsByCategory}
        supportTypes={reference.supportTypes}
        disabled={disabled}
      />
      <CertificationsEditSection
        draft={draft}
        initial={initial}
        update={update}
        certificationsByCategory={reference.certificationsByCategory}
        disabled={disabled}
      />
    </div>
  );
}
