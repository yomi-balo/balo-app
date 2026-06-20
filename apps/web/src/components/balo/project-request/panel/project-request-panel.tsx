'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, Loader2, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import { Drawer, DrawerHeader, DrawerBody, DrawerFooter, FlowStepper } from '@/components/flow';
import { InputFloating } from '@/components/enhanced/input-floating';
import { RichTextEditor, validateDescription } from '@/components/balo/rich-text-editor';
import { TaxonomyMultiSelect } from '@/components/balo/taxonomy-multi-select';
import { DocumentUploader } from '@/components/balo/document-uploader';
import { buildProductNameMap, EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { centsToDollars, dollarsToCents } from '@/lib/utils/currency';
import { cn } from '@/lib/utils';
import type { ProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import { submitProjectRequestAction } from '@/lib/project-request/actions/submit-project-request';
import { refetchProjectTaxonomiesAction } from '@/lib/project-request/actions/refetch-project-taxonomies';
import { PROJECT_PATHS, PROJECT_STEPS } from './constants';
import { FieldLabel } from './field-label';
import { PathCard } from './path-card';
import { SendToSelector, type ProjectRouting } from './send-to-selector';
import { ReviewSummary } from './review-summary';
import {
  useProjectDraft,
  type ProjectDraft,
  type ProjectRequestEntryPoint,
} from './use-project-draft';

export type { ProjectRequestEntryPoint } from './use-project-draft';

/** Expert display data used by the Direct routing card + review/done copy. */
interface ProjectRequestExpert {
  name: string;
  firstName: string;
  initials: string;
  /** R2 key / http URL for the avatar. */
  avatarKey: string | null;
}

export interface ProjectRequestPanelProps {
  open: boolean;
  /** Replaces the old `onOpenChange` — the panel only ever asks to CLOSE. */
  onClose: () => void;
  /** Where the panel was opened from. Drives autosave-key fallback + analytics dimension. */
  entryPoint: ProjectRequestEntryPoint;
  /**
   * When present → expert-bound mode: routing defaults to `direct` (this expert),
   * the SendToSelector + done copy bind to the expert, submit sends `sendTo:'direct'`.
   * When absent → context-free mode: routing defaults to `match` ("Match for me"),
   * the Direct card still renders (selectable) but with a neutral "an expert" media,
   * submit sends `sendTo:'match'`.
   */
  expertProfileId?: string;
  /**
   * Expert display data — REQUIRED in practice whenever `expertProfileId` is set
   * (the Direct card / review block need a name + avatar). Grouped into one optional
   * object so context-free callers pass nothing. Absent → context-free rendering.
   */
  expert?: ProjectRequestExpert;
  /**
   * Pre-loaded taxonomies (RSC-side). OPTIONAL: when omitted (context-free mounts
   * with no RSC parent), the panel self-loads via `refetchProjectTaxonomiesAction`
   * on first open and shows the picker's existing loading→error/Retry states.
   */
  projectTaxonomies?: ProjectRequestTaxonomies;
  /** Fired after a successful submit with the created request id. */
  onSubmitted?: (requestId: string) => void;
}

/** Mutable steps for the stepper (the readonly `as const` tuple isn't assignable). */
const STEPPER_STEPS = PROJECT_STEPS.map((s) => ({ key: s.key, label: s.label }));

const DESCRIPTION_PLACEHOLDER_SUFFIX = ' later.';

const EMPTY_TAXONOMIES: ProjectRequestTaxonomies = {
  tags: EMPTY_TAXONOMY,
  products: EMPTY_TAXONOMY,
};

/** Routing-aware copy — keyed off `draft.routing` to drive the whole flow. */
interface RoutingCopy {
  /**
   * Routing-aware framing line above the `manual`-step routing selector. Match
   * gets an explicit matching promise; Direct stays unframed (the panel's
   * "Start a project with {expertName}" heading is sufficient).
   */
  manualHeading: string | null;
  formDescription: string;
  submitCta: string;
  successDescription: string;
  doneHeading: string;
  doneBody: string;
  reviewReassurance: string;
}

const MATCH_COPY: RoutingCopy = {
  manualHeading: "Tell us what you need and we'll match you with the right expert.",
  formDescription:
    'Our team reviews your brief and introduces a matched expert, usually within a day.',
  submitCta: 'Find me an expert',
  successDescription: "We'll introduce a matched expert soon.",
  doneHeading: "Request sent — we're finding your expert",
  doneBody:
    "Our team will review your brief and introduce a matched expert, usually within a day. We'll email you and notify you in-app.",
  reviewReassurance:
    'Our team reviews briefs within a day and introduces a matched expert. No charge to send.',
};

/**
 * Routing-aware copy. The Direct copy is only used when an expert is bound (the
 * panel clamps a context-free Direct selection to Match), so `firstName` is
 * always defined on the Direct branch.
 */
function getRoutingCopy(routing: ProjectRouting, firstName: string | undefined): RoutingCopy {
  if (routing === 'direct' && firstName !== undefined) {
    return {
      manualHeading: null,
      formDescription: `${firstName} receives this brief directly.`,
      submitCta: `Send to ${firstName}`,
      successDescription: `${firstName} will reply with a proposal.`,
      doneHeading: `Request sent to ${firstName}`,
      doneBody: `${firstName} will review your brief and reply with a scoped proposal, usually within a day. We'll email you and notify you in-app.`,
      reviewReassurance: `${firstName} usually replies within a day. You won't be charged anything to send this.`,
    };
  }
  return MATCH_COPY;
}

/**
 * Top-level project-request panel. State machine: `start → manual → review →
 * done` (the AI path renders as a disabled card only). Built on the shared
 * `Drawer` / `FlowStepper` flow primitives. Field set (BAL-259): routing
 * (Direct/Match) → title → rich-text brief → optional tags → optional products →
 * optional documents. Routing colours the heading, review summary, submit CTA,
 * and done screen. Autosaves to localStorage and submits via the
 * `submitProjectRequestAction` Server Action (discriminated union on `sendTo`).
 *
 * Two mount modes:
 *  - **Expert-bound** (`expertProfileId` + `expert` supplied): routing defaults
 *    to Direct, the selector/copy bind to the expert, submit sends `direct`.
 *  - **Context-free** (no expert): routing defaults to Match, the Direct card is
 *    neutral, submit clamps to `match` (there is no id to route to).
 *
 * Taxonomies are supplied RSC-side (expert-bound profile) or self-loaded via the
 * Retry action on first open (context-free).
 */
export function ProjectRequestPanel({
  open,
  onClose,
  entryPoint,
  expertProfileId,
  expert,
  projectTaxonomies,
  onSubmitted,
}: Readonly<ProjectRequestPanelProps>): React.JSX.Element {
  const [step, setStep] = useState<ProjectStep>('start');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Snapshot of the routing at submit time — the done screen + success toast read
  // this, NOT the live draft (which `clearDraft()` resets on success).
  const expertBound = expertProfileId !== undefined;
  const [submittedRouting, setSubmittedRouting] = useState<ProjectRouting>(
    expertBound ? 'direct' : 'match'
  );

  const { draft, setField, clearDraft } = useProjectDraft(expertProfileId, entryPoint);
  const { routing, title, descriptionHtml, tagIds, productIds, budgetMinCents, budgetMaxCents } =
    draft;

  // Local taxonomy state so Retry / self-load can refresh without a page reload.
  // Context-free mounts (no RSC-supplied taxonomies) seed EMPTY and self-load.
  const initialTaxonomies = projectTaxonomies ?? EMPTY_TAXONOMIES;
  const [taxonomies, setTaxonomies] = useState<ProjectRequestTaxonomies>(initialTaxonomies);
  // The project taxonomy is always seeded, so an empty `groups` for an RSC-supplied
  // prop means the load failed (returned EMPTY_TAXONOMY) — surface the error state.
  // Context-free mounts start empty and self-load on first open, so the error flag
  // stays false until a self-load attempt fails.
  const [tagsError, setTagsError] = useState(
    projectTaxonomies !== undefined && projectTaxonomies.tags.groups.length === 0
  );
  const [productsError, setProductsError] = useState(
    projectTaxonomies !== undefined && projectTaxonomies.products.groups.length === 0
  );
  const [retrying, setRetrying] = useState(false);
  // True once a context-free self-load has been kicked off (guard against re-fire).
  const selfLoadedRef = useRef(false);

  // Sync from the RSC-supplied taxonomies prop ONLY when it is provided (expert-bound).
  // Context-free mounts have no prop and rely on the self-load below instead.
  useEffect(() => {
    if (projectTaxonomies === undefined) return;
    setTaxonomies(projectTaxonomies);
    setTagsError(projectTaxonomies.tags.groups.length === 0);
    setProductsError(projectTaxonomies.products.groups.length === 0);
  }, [projectTaxonomies]);

  const titleInputRef = useRef<HTMLInputElement>(null);

  const tagNameMap = useMemo(() => buildProductNameMap(taxonomies.tags), [taxonomies.tags]);
  const productNameMap = useMemo(
    () => buildProductNameMap(taxonomies.products),
    [taxonomies.products]
  );

  const tagIdSet = useMemo(() => new Set(tagIds), [tagIds]);
  const productIdSet = useMemo(() => new Set(productIds), [productIds]);

  const trimmedTitle = title.trim();
  const titleValid = trimmedTitle.length >= 3 && trimmedTitle.length <= 120;
  const descriptionError = validateDescription(descriptionHtml);
  // An incoherent budget range (max < min, both present) blocks Review, just like
  // title/description do. One-sided ranges (either null) are always valid.
  const budgetRangeInvalid =
    budgetMinCents !== null && budgetMaxCents !== null && budgetMaxCents < budgetMinCents;
  const reviewValid = titleValid && descriptionError === null && !budgetRangeInvalid;

  const expertFirstName = expert?.firstName;
  const copy = getRoutingCopy(routing, expertFirstName);
  // Done screen uses the snapshot (draft is cleared on success).
  const doneCopy = getRoutingCopy(submittedRouting, expertFirstName);

  const handleRetryTaxonomies = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const next = await refetchProjectTaxonomiesAction();
      setTaxonomies(next);
      setTagsError(next.tags.groups.length === 0);
      setProductsError(next.products.groups.length === 0);
    } catch {
      setTagsError(true);
      setProductsError(true);
    } finally {
      setRetrying(false);
    }
  }, [retrying]);

  // Fire `drawer_opened` once per open (guard against the effect re-running).
  const openFiredRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openFiredRef.current = false;
      return;
    }
    if (openFiredRef.current) return;
    openFiredRef.current = true;
    setStep('start');
    setError(null);
    setShowValidation(false);
    // expert_id-keyed event — fired only when expert-bound (context-free analytics
    // is a follow-up; the @balo/analytics event map is intentionally not widened).
    if (expertProfileId !== undefined) {
      track(PROJECT_EVENTS.PROJECT_DRAWER_OPENED, { expert_id: expertProfileId });
    }
    // Context-free self-load: taxonomies were not RSC-supplied, so fetch them once
    // on first open (reusing the Retry path + the picker's loading/error UI).
    if (projectTaxonomies === undefined && !selfLoadedRef.current) {
      selfLoadedRef.current = true;
      handleRetryTaxonomies().catch(() => {});
    }
  }, [open, expertProfileId, projectTaxonomies, handleRetryTaxonomies]);

  // `step_viewed` on every step change while open (expert-bound only).
  useEffect(() => {
    if (!open) return;
    if (expertProfileId === undefined) return;
    track(PROJECT_EVENTS.PROJECT_STEP_VIEWED, { expert_id: expertProfileId, step });
  }, [open, step, expertProfileId]);

  // Clear any stale submit error once the user leaves the review step.
  useEffect(() => {
    if (step !== 'review') setError(null);
  }, [step]);

  // Focus the title field when (and only when) the manual step becomes active.
  useEffect(() => {
    if (step === 'manual') titleInputRef.current?.focus();
  }, [step]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleSelectManual = useCallback(() => {
    if (expertProfileId !== undefined) {
      track(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
        expert_id: expertProfileId,
        method: 'manual',
      });
    }
    setStep('manual');
  }, [expertProfileId]);

  const handleJump = useCallback((key: string) => {
    if (key === 'start' || key === 'manual' || key === 'review') setStep(key);
  }, []);

  const handleGoReview = useCallback(() => {
    setShowValidation(true);
    if (reviewValid) setStep('review');
  }, [reviewValid]);

  const handleDocumentsChange = useCallback(
    (docs: ProjectDraft['documents']) => setField('documents', docs),
    [setField]
  );

  // Budget inputs are WHOLE DOLLARS (numeric, coarse ranges). We take the part
  // before any decimal point (a stray "45000.50" collapses to 45000 dollars,
  // never fractional-dollar cents) then strip every remaining non-digit — so
  // thousands separators ("1,500") are tolerated — and persist `dollars × 100`
  // cents. This keeps input ↔ stored cents ↔ formatted display in lock-step
  // (stored cents are always a multiple of 100). Empty / no digits → null.
  const handleBudgetChange = useCallback(
    (key: 'budgetMinCents' | 'budgetMaxCents', raw: string) => {
      const [wholePart = ''] = raw.split('.');
      const digits = wholePart.replace(/\D/g, '');
      if (digits === '') {
        setField(key, null);
        return;
      }
      const dollars = Number.parseInt(digits, 10);
      if (!Number.isFinite(dollars)) {
        setField(key, null);
        return;
      }
      setField(key, dollarsToCents(dollars));
    },
    [setField]
  );

  const handleTimelineChange = useCallback(
    (raw: string) => setField('timeline', raw.length === 0 ? null : raw),
    [setField]
  );

  /** Cents → whole-dollar string for the controlled input (empty when null). */
  const budgetDollarsValue = useCallback(
    (cents: number | null): string => (cents === null ? '' : String(centsToDollars(cents))),
    []
  );

  const toggleTag = useCallback(
    (id: string) => {
      const next = tagIdSet.has(id) ? tagIds.filter((t) => t !== id) : [...tagIds, id];
      setField('tagIds', next);
    },
    [tagIdSet, tagIds, setField]
  );

  const toggleProduct = useCallback(
    (id: string) => {
      const next = productIdSet.has(id) ? productIds.filter((p) => p !== id) : [...productIds, id];
      setField('productIds', next);
    },
    [productIdSet, productIds, setField]
  );

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);

    const base = {
      title: trimmedTitle,
      description: descriptionHtml,
      tagIds,
      productIds,
      documents: draft.documents,
      source: 'manual' as const,
      budgetMinCents: draft.budgetMinCents,
      budgetMaxCents: draft.budgetMaxCents,
      timeline: draft.timeline,
    };
    // Submit clamp: only emit `direct` when there is an expert id to route to.
    // A context-free Direct selection (or any missing id) falls back to `match`.
    const sendDirect = expertProfileId !== undefined && routing === 'direct';
    const payload = sendDirect
      ? { sendTo: 'direct' as const, expertProfileId, ...base }
      : { sendTo: 'match' as const, ...base };
    // The routing actually submitted (clamped) — drives the done screen + toast.
    const effectiveRouting: ProjectRouting = sendDirect ? 'direct' : 'match';

    const result = await submitProjectRequestAction(payload);
    setSubmitting(false);

    if (!result.success) {
      const message = result.error ?? 'Something went wrong. Please try again.';
      setError(message);
      toast.error(message);
      return;
    }

    if (expertProfileId !== undefined) {
      track(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
        expert_id: expertProfileId,
        send_to: effectiveRouting,
        tag_count: tagIds.length,
        product_count: productIds.length,
        document_count: draft.documents.length,
        method: 'manual',
      });
    }
    // Snapshot routing for the done screen BEFORE clearing the draft (clear resets
    // routing to the computed default), so Match submits keep their done copy.
    setSubmittedRouting(effectiveRouting);
    clearDraft();
    const successCopy = getRoutingCopy(effectiveRouting, expertFirstName);
    toast.success('Request sent', { description: successCopy.successDescription });
    setStep('done');
    if (result.projectRequestId !== undefined) onSubmitted?.(result.projectRequestId);
  }, [
    routing,
    expertProfileId,
    expertFirstName,
    trimmedTitle,
    descriptionHtml,
    tagIds,
    productIds,
    draft.documents,
    draft.budgetMinCents,
    draft.budgetMaxCents,
    draft.timeline,
    clearDraft,
    onSubmitted,
  ]);

  const submitDisabled = !reviewValid || submitting || uploading;

  const startHeading = expert ? `Start a project with ${expert.name}` : 'Start a project';
  const startBody =
    expertFirstName === undefined
      ? "Tell us what you need and we'll match you with the right expert. Pick how you'd like to begin — it only takes a minute or two."
      : `Tell us what you need and ${expertFirstName} replies with a scoped proposal. Pick how you'd like to begin — it only takes a minute or two.`;

  const descriptionRefinePerson =
    expertFirstName === undefined ? 'with your expert' : `with ${expertFirstName}`;

  const manualBody = (
    <div className="space-y-6 p-6">
      <button
        type="button"
        onClick={() => setStep('start')}
        className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Change entry method
      </button>

      {/* 2.1 — Send request to */}
      <div className="space-y-2">
        {copy.manualHeading !== null && (
          <p className="text-foreground text-sm leading-relaxed font-medium">
            {copy.manualHeading}
          </p>
        )}
        <FieldLabel>Send request to</FieldLabel>
        <SendToSelector
          value={routing}
          onChange={(r) => setField('routing', r)}
          expertName={expert?.name}
          expertInitials={expert?.initials}
          expertAvatarKey={expert?.avatarKey}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">{copy.formDescription}</p>
      </div>

      {/* 2.2 — Title */}
      <div className="space-y-2">
        <InputFloating
          ref={titleInputRef}
          label="Project title"
          value={title}
          onChange={(e) => setField('title', e.target.value)}
          aria-invalid={showValidation && !titleValid}
        />
        {showValidation && !titleValid && (
          <p role="alert" className="text-destructive text-xs">
            {trimmedTitle.length > 120
              ? 'Keep your title under 120 characters.'
              : 'Give your project a title (at least 3 characters).'}
          </p>
        )}
      </div>

      {/* 2.3 — Description */}
      <div className="space-y-2">
        <FieldLabel>What do you need?</FieldLabel>
        <RichTextEditor
          value={descriptionHtml}
          onChange={(html) => setField('descriptionHtml', html)}
          placeholder={`Describe the problem or the outcome you're after — bullet points are fine. You can refine it ${descriptionRefinePerson}${DESCRIPTION_PLACEHOLDER_SUFFIX}`}
        />
        {showValidation && descriptionError !== null && (
          <p role="alert" className="text-destructive text-xs">
            {descriptionError}
          </p>
        )}
        <p className="text-muted-foreground text-xs leading-relaxed">
          Keep it as short as you like — a rough sketch is fine.
        </p>
      </div>

      {/* 2.4 — Project type (tags) */}
      <div className="space-y-2">
        <FieldLabel optional>Project type</FieldLabel>
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          Pick the categories that best describe this work — helps us scope it.
        </p>
        <TaxonomyMultiSelect
          taxonomy={taxonomies.tags}
          selectedIds={tagIdSet}
          nameMap={tagNameMap}
          onToggle={toggleTag}
          onClear={() => setField('tagIds', [])}
          loading={retrying && taxonomies.tags.groups.length === 0}
          error={tagsError}
          onRetry={handleRetryTaxonomies}
          inSheet
          fieldId="tags"
          searchPlaceholder="Filter project types…"
          emptyCopy="Project types couldn't load right now."
          errorCopy="Couldn't load project types. You can still send your request."
          noMatchNoun="project types"
        />
      </div>

      {/* 2.5 — Products */}
      <div className="space-y-2">
        <FieldLabel optional>Salesforce products</FieldLabel>
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          Which products does this touch? Same list as expert search.
        </p>
        <TaxonomyMultiSelect
          taxonomy={taxonomies.products}
          selectedIds={productIdSet}
          nameMap={productNameMap}
          onToggle={toggleProduct}
          onClear={() => setField('productIds', [])}
          loading={retrying && taxonomies.products.groups.length === 0}
          error={productsError}
          onRetry={handleRetryTaxonomies}
          inSheet
          fieldId="products"
          searchPlaceholder="Filter products…"
          emptyCopy="Products couldn't load right now."
          errorCopy="Couldn't load products. You can still send your request."
          noMatchNoun="products"
        />
      </div>

      {/* 2.6 — Documents */}
      <div className="space-y-2">
        <FieldLabel optional>Attach documents</FieldLabel>
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          PDF, PNG, JPEG or WEBP · up to 4 files · 5 MB each.
        </p>
        <DocumentUploader
          onDocumentsChange={handleDocumentsChange}
          onUploadingChange={setUploading}
        />
      </div>

      {/* 2.7 — Budget & timeline (optional) */}
      <div className="space-y-2">
        <FieldLabel optional>Budget &amp; timeline</FieldLabel>
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          Optional — helps the expert scope and price the work.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InputFloating
            label="Min budget (A$)"
            inputMode="numeric"
            value={budgetDollarsValue(budgetMinCents)}
            onChange={(e) => handleBudgetChange('budgetMinCents', e.target.value)}
            aria-invalid={budgetRangeInvalid}
          />
          <InputFloating
            label="Max budget (A$)"
            inputMode="numeric"
            value={budgetDollarsValue(budgetMaxCents)}
            onChange={(e) => handleBudgetChange('budgetMaxCents', e.target.value)}
            aria-invalid={budgetRangeInvalid}
          />
        </div>
        {budgetRangeInvalid && (
          <p role="alert" className="text-destructive text-xs">
            Max budget must be at least the minimum.
          </p>
        )}
        <InputFloating
          label="Timeline"
          placeholder="Target go-live: end of Q3"
          value={draft.timeline ?? ''}
          onChange={(e) => handleTimelineChange(e.target.value)}
        />
      </div>
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Start a project"
      widthClassName="sm:max-w-[560px]"
    >
      <div className="flex h-full flex-col">
        <DrawerHeader onClose={handleClose}>
          {step === 'done' ? (
            <h2 className="text-foreground text-base font-semibold">Request sent</h2>
          ) : (
            <FlowStepper steps={STEPPER_STEPS} current={step} onJump={handleJump} />
          )}
        </DrawerHeader>

        <DrawerBody>
          {step === 'start' && (
            <div className="space-y-5 p-6">
              <div className="space-y-2">
                <h2 className="text-foreground text-xl font-semibold tracking-[-0.01em]">
                  {startHeading}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">{startBody}</p>
              </div>
              <div className="flex flex-col gap-3">
                {PROJECT_PATHS.map((path) => (
                  <PathCard
                    key={path.key}
                    path={path}
                    onClick={path.key === 'manual' ? handleSelectManual : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {step === 'manual' && manualBody}

          {step === 'review' && (
            <div className="space-y-4 p-6">
              <ReviewSummary
                draft={draft}
                expertName={expert?.name}
                expertInitials={expert?.initials}
                expertAvatarKey={expert?.avatarKey}
                tagNameMap={tagNameMap}
                productNameMap={productNameMap}
                onEdit={() => setStep('manual')}
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {copy.reviewReassurance}
              </p>
              {uploading && <p className="text-muted-foreground text-sm">Finishing uploads…</p>}
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="px-8 py-12 text-center">
              <span className="from-primary mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br to-violet-600 text-white shadow-[0_8px_28px_rgba(99,102,241,0.35)] dark:to-violet-500">
                {submittedRouting === 'match' ? (
                  <Sparkles className="h-7 w-7" aria-hidden="true" />
                ) : (
                  <Send className="h-7 w-7" aria-hidden="true" />
                )}
              </span>
              <h2 className="text-foreground text-xl font-semibold">{doneCopy.doneHeading}</h2>
              <p className="text-muted-foreground mx-auto mt-2.5 max-w-[340px] text-sm leading-relaxed">
                {doneCopy.doneBody}
              </p>
            </div>
          )}
        </DrawerBody>

        {step === 'manual' && (
          <DrawerFooter>
            <BackButton onClick={() => setStep('start')} />
            <PrimaryButton onClick={handleGoReview}>
              Review <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PrimaryButton>
          </DrawerFooter>
        )}

        {step === 'review' && (
          <DrawerFooter>
            <BackButton onClick={() => setStep('manual')} disabled={submitting} />
            <PrimaryButton onClick={handleSubmit} disabled={submitDisabled}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Sending…
                </>
              ) : (
                <>
                  {routing === 'match' ? (
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}{' '}
                  {copy.submitCta}
                </>
              )}
            </PrimaryButton>
          </DrawerFooter>
        )}

        {step === 'done' && (
          <DrawerFooter className="justify-end">
            <PrimaryButton onClick={handleClose}>Done</PrimaryButton>
          </DrawerFooter>
        )}
      </div>
    </Drawer>
  );
}

function BackButton({
  onClick,
  disabled,
}: Readonly<{ onClick: () => void; disabled?: boolean }>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-border bg-card text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
    </button>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: Readonly<{
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'from-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r to-violet-600 px-6 text-sm font-semibold text-white shadow-sm transition-all focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:outline-none dark:to-violet-500',
        'enabled:hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none'
      )}
    >
      {children}
    </button>
  );
}
