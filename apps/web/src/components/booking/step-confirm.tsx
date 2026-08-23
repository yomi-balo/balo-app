'use client';

import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import { TaxonomyMultiSelect } from '@/components/balo/taxonomy-multi-select';
import { buildProductNameMap, type ProductTaxonomy } from '@/lib/search/taxonomy';
import type { EligibleCompany } from '@balo/shared/credit';
import { formatSlotDateTime } from './format';
import { CaseChoiceSection } from './case-choice-section';
import { CaseContextCard } from './case-context-card';
import { CompanyPicker, CompanyPickerErrorBanner } from './company-picker';
import { GuestInviteComposer, type GuestDraft } from './guest-invite-composer';
import { BillingLine, CancellationLine } from './billing-line';
import { StaleSlotBanner } from './booking-error-panels';
import type { FixedCaseSummary, OpenCaseForExpert } from './types';

export interface ConfirmSlot {
  startIso: string;
  endIso: string;
  durationMinutes: 15 | 30 | 45 | 60;
}

export type CaseSelection = { kind: 'new' } | { kind: 'existing'; engagementId: string };

export interface StepConfirmProps {
  slot: ConfirmSlot;
  viewerTimezone: string;
  expertFirstName: string | null;
  onChangeTime: () => void;

  /** `null` when entry point 3 fixed the case — the whole case-choice section is absent (D4a #3). */
  openCases: readonly OpenCaseForExpert[] | null;
  /**
   * UX-3 (BAL-400 round 2) — true only while a company (re)selection's open-cases read is in
   * flight. Design §Case choice section "Loading": a 2-row skeleton appears above the
   * title/description, which render immediately regardless (the safe "new case" default).
   */
  caseChoiceLoading: boolean;
  caseSelection: CaseSelection;
  onCaseSelectionChange: (selection: CaseSelection) => void;
  /**
   * The read-only card's data for the ATTACH shape, resolved by the wrapper (owner) from
   * whichever source applies: entry point 3's fixed case, a chooser selection matched against
   * `openCases`, or a partial-failure's just-created case (which cannot yet appear in
   * `openCases`). `null` while `caseSelection.kind === 'new'`.
   */
  caseContextSummary: FixedCaseSummary | null;
  /** Entry point 3 has no "wrong case" escape (the client explicitly chose it). */
  showCaseEscapeHatch: boolean;

  title: string;
  onTitleChange: (title: string) => void;
  descriptionHtml: string;
  onDescriptionChange: (html: string) => void;
  productIds: readonly string[];
  onProductIdsChange: (ids: readonly string[]) => void;
  productsTaxonomy: ProductTaxonomy;
  showValidation: boolean;

  /** Only meaningful for a NEW case with >1 eligible company. `null` entries hide the picker. */
  companies: readonly EligibleCompany[] | null;
  companyReadFailed: boolean;
  onRetryCompanies: () => void;
  companyId: string | null;
  onCompanyIdChange: (id: string) => void;
  /**
   * UX-1 (BAL-400 round 2) — "does this client have >1 eligible company," independent of
   * `caseSelection.kind`. `companies` above is deliberately forced to `null` on every attach
   * shape (it also gates the new-case-only `CompanyPicker`), so it cannot double as this
   * note's visibility gate — that was the bug. This prop is derived from the wrapper's
   * un-nulled `companies` state and is the ONLY thing the billing-account note gates on.
   */
  hasMultipleEligibleCompanies: boolean;

  guests: readonly GuestDraft[];
  onGuestsChange: (guests: readonly GuestDraft[]) => void;
  viewerEmailDomain: string | null;
  clientCompanyName: string | null;

  staleSlot: boolean;

  submitting: boolean;
  submitDisabled: boolean;
  onBack: () => void;
  onSubmit: () => void;
}

const TITLE_MAX = 160;

/**
 * BAL-400 Step 2 — both confirm shapes (new / attach), the case-choice section, and the
 * attach⇄new crossfade transition. Design §Step 2.
 */
export function StepConfirm(props: Readonly<StepConfirmProps>): React.JSX.Element {
  const {
    slot,
    viewerTimezone,
    expertFirstName,
    onChangeTime,
    openCases,
    caseChoiceLoading,
    caseSelection,
    onCaseSelectionChange,
    caseContextSummary,
    showCaseEscapeHatch,
    title,
    onTitleChange,
    descriptionHtml,
    onDescriptionChange,
    productIds,
    onProductIdsChange,
    productsTaxonomy,
    showValidation,
    companies,
    companyReadFailed,
    onRetryCompanies,
    companyId,
    onCompanyIdChange,
    hasMultipleEligibleCompanies,
    guests,
    onGuestsChange,
    viewerEmailDomain,
    clientCompanyName,
    staleSlot,
    submitting,
    submitDisabled,
    onBack,
    onSubmit,
  } = props;

  const productNameMap = useMemo(() => buildProductNameMap(productsTaxonomy), [productsTaxonomy]);
  const productIdSet = useMemo(() => new Set(productIds), [productIds]);

  const isNewCase = caseSelection.kind === 'new';
  const selectedEngagementId =
    caseSelection.kind === 'existing' ? caseSelection.engagementId : null;
  const trimmedTitle = title.trim();
  const titleValid = trimmedTitle.length >= 1 && trimmedTitle.length <= TITLE_MAX;
  // M2 — a REAL-TEXT check: `isDescriptionEmpty` reads plain-text length, so an editor holding
  // only a bare `<p></p>` (markup non-emptiness) still fails, matching design §2.3.
  const descriptionEmpty = isDescriptionEmpty(descriptionHtml);

  return (
    <div className="space-y-5 p-6">
      {staleSlot && <StaleSlotBanner onChooseNewTime={onChangeTime} />}

      <div className="border-border bg-muted/30 flex items-center justify-between rounded-xl border p-4">
        <div>
          <p className="text-foreground text-sm font-semibold">
            {formatSlotDateTime(slot.startIso, viewerTimezone)}
          </p>
          <p className="text-muted-foreground text-xs">
            {slot.durationMinutes}-minute consultation
          </p>
        </div>
        <button
          type="button"
          onClick={onChangeTime}
          className="text-primary focus-visible:ring-ring rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          See other times
        </button>
      </div>

      {caseChoiceLoading && openCases === null && (
        <div className="space-y-2" data-testid="case-choice-skeleton">
          <div className="bg-muted h-14 animate-pulse rounded-lg" />
          <div className="bg-muted h-14 animate-pulse rounded-lg" />
        </div>
      )}

      {openCases !== null && openCases.length > 0 && (
        <CaseChoiceSection
          openCases={openCases}
          selectedEngagementId={selectedEngagementId}
          onSelect={(id) =>
            onCaseSelectionChange(
              id === null ? { kind: 'new' } : { kind: 'existing', engagementId: id }
            )
          }
          expertFirstName={expertFirstName}
        />
      )}

      <AnimatePresence mode="wait" initial={false}>
        {isNewCase ? (
          <motion.div
            key="new"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="space-y-5 overflow-hidden"
          >
            <div className="space-y-2">
              <label htmlFor="booking-title" className="text-foreground text-sm font-semibold">
                Title <span className="text-destructive">*</span>
              </label>
              <Input
                id="booking-title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder="In a few words, what's this about?"
                maxLength={TITLE_MAX}
                aria-invalid={showValidation && !titleValid}
              />
              {showValidation && !titleValid && (
                <p role="alert" className="text-destructive text-xs">
                  Give this a short title.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-foreground text-sm font-semibold">
                Description <span className="text-destructive">*</span>
              </p>
              <RichTextEditor
                value={descriptionHtml}
                onChange={onDescriptionChange}
                placeholder="What would you like to discuss?"
                ariaLabel="What you'd like to discuss"
              />
              {showValidation && descriptionEmpty && (
                <p role="alert" className="text-destructive text-xs">
                  Add a few words about what you&apos;d like to discuss.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-foreground text-sm font-semibold">
                Salesforce products{' '}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </p>
              <TaxonomyMultiSelect
                taxonomy={productsTaxonomy}
                selectedIds={productIdSet}
                nameMap={productNameMap}
                onToggle={(id) =>
                  onProductIdsChange(
                    productIdSet.has(id) ? productIds.filter((p) => p !== id) : [...productIds, id]
                  )
                }
                onClear={() => onProductIdsChange([])}
                inSheet
                fieldId="booking-products"
                searchPlaceholder="Filter products…"
                emptyCopy="Products couldn't load right now."
                errorCopy="Couldn't load products. You can still book."
                noMatchNoun="products"
              />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="attach"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="space-y-3 overflow-hidden"
          >
            {caseContextSummary !== null && (
              <CaseContextCard
                title={caseContextSummary.title}
                consultationCount={caseContextSummary.consultationCount}
                openedAtIso={caseContextSummary.openedAtIso}
                onSwitchToNew={
                  showCaseEscapeHatch ? () => onCaseSelectionChange({ kind: 'new' }) : undefined
                }
              />
            )}
            {clientCompanyName !== null && hasMultipleEligibleCompanies && (
              <p className="text-muted-foreground text-xs">
                Billed to {clientCompanyName} — same as the rest of this case.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <GuestInviteComposer
        guests={guests}
        onChange={onGuestsChange}
        otherParticipantCount={2}
        viewerEmailDomain={viewerEmailDomain}
        clientCompanyName={clientCompanyName}
      />

      {isNewCase && companies !== null && companies.length > 1 && (
        <CompanyPicker companies={companies} value={companyId} onChange={onCompanyIdChange} />
      )}
      {isNewCase && companyReadFailed && <CompanyPickerErrorBanner onRetry={onRetryCompanies} />}

      <BillingLine />

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
          </Button>
          <Button type="button" className="flex-1" onClick={onSubmit} disabled={submitDisabled}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Booking…
              </>
            ) : (
              'Confirm & book'
            )}
          </Button>
        </div>
        {isNewCase && companies !== null && companies.length > 1 && companyId === null && (
          <p className="text-muted-foreground text-center text-xs">
            Choose which account this is billed to
          </p>
        )}
        <CancellationLine />
      </div>
    </div>
  );
}
