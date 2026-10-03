'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  ChevronLeft,
  Loader2,
  MessageSquare,
  RotateCw,
  Send,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';
import { Drawer, DrawerHeader, DrawerBody, DrawerFooter, FlowStepper } from '@/components/flow';
import { InputFloating } from '@/components/enhanced/input-floating';
import {
  RichTextEditor,
  RichTextViewer,
  validateDescription,
} from '@/components/balo/rich-text-editor';
import { TaxonomyMultiSelect } from '@/components/balo/taxonomy-multi-select';
import { DocumentUploader } from '@/components/balo/document-uploader';
import { buildProductNameMap, EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { centsToDollars, dollarsToCents } from '@/lib/utils/currency';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import { MAX_DOCUMENTS, type ProjectDocumentRef } from '@/lib/project-request/actions/schemas';
import { submitProjectRequestAction } from '@/lib/project-request/actions/submit-project-request';
import { refetchProjectTaxonomiesAction } from '@/lib/project-request/actions/refetch-project-taxonomies';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';
import { PROJECT_PATHS, PROJECT_STEPS, PROJECT_STEPS_AI, PROJECT_STEPS_CASE } from './constants';
import { FieldLabel } from './field-label';
import { PathCard } from './path-card';
import {
  SendToSelector,
  ExpertUnavailableNotice,
  type ProjectRequestExpert,
  type ProjectRouting,
} from './send-to-selector';
import { ReviewSummary } from './review-summary';
import { useProjectRouting } from './use-project-routing';
import { useExpertUnavailableOverride } from './use-expert-unavailable-override';
import { GenerationErrorBanner } from './generation-error-banner';
import { useAiBriefFlow } from './use-ai-brief-flow';
import {
  useCaseBriefFlow,
  type CaseBriefPhase,
  type UseCaseBriefFlowResult,
} from './use-case-brief-flow';
import { CaseFilePicker } from './case-file-picker';
import { initialStepFor, type ProjectRequestSeed } from './project-seed';
import { useProjectSeed } from './use-project-seed';
import { NewRequestNotice } from './new-request-notice';
import { projectFunnelDimensions } from './funnel-dimensions';
import {
  useProjectDraft,
  allDraftDocuments,
  type ProjectDraft,
  type ProjectRequestEntryPoint,
  type SetProjectDraftField,
} from './use-project-draft';

export type { ProjectRequestEntryPoint } from './use-project-draft';

/**
 * BAL-589 — what a "Convert to project" mount (`convert-to-project.tsx`) hands the panel: the
 * case's own id/title (for the draft key, the audit provenance and the "Linked to case" copy),
 * its live product ids (prefill) and its file rows (`CaseFilePicker`'s "From this case"
 * list). One object, not a bare `caseId` — so the title/products/files can never
 * arrive without the id.
 */
export interface ProjectRequestSourceCase {
  id: string;
  title: string;
  productIds: readonly string[];
  files: readonly CaseFileRowView[];
}

/**
 * Everything `CaseBriefField` (the manual step's description block on a case mount) and
 * `CaseFilePicker` need, bundled into the single optional prop `ManualStepFields` gains for
 * BAL-589 — kept out of `ManualStepFieldsProps` itself so a non-case mount's prop list is
 * unchanged.
 */
interface CaseBriefBundle {
  sourceCase: ProjectRequestSourceCase;
  phase: CaseBriefPhase;
  failureReason: ProjectBriefFailureReason | null;
  revealedHtml: string | null;
  hasAiDraft: boolean;
  onRedraftClick: () => void;
  onRetry: () => void;
  onDismissFailure: () => void;
  /** The uploader's own document count — `CaseFilePicker` combines it with its own selection
   *  count for the shared cap. */
  uploadedDocumentCount: number;
  caseFileSelections: Record<string, ProjectDocumentRef>;
  onCaseFileSelectionsChange: (
    updater: (prev: Record<string, ProjectDocumentRef>) => Record<string, ProjectDocumentRef>
  ) => void;
}

export interface ProjectRequestPanelProps {
  open: boolean;
  /** Replaces the old `onOpenChange` — the panel only ever asks to CLOSE. */
  onClose: () => void;
  /** Where the panel was opened from. Drives autosave-key fallback + analytics dimension. */
  entryPoint: ProjectRequestEntryPoint;
  /**
   * When present → expert-bound mode: routing defaults to `direct` (this expert), the
   * SendToSelector pins the expert's card with a toggle to get matched instead, and done copy
   * binds to the expert; submit sends `sendTo:'direct'` (or `'match'` once toggled).
   * When absent → context-free mode: routing is always `match` ("Find me an expert") and the
   * selector is a static block with nothing to choose; submit sends `sendTo:'match'`.
   */
  expertProfileId?: string;
  /**
   * Expert display data — REQUIRED in practice whenever `expertProfileId` is set
   * (the recipient card / review block need a name + avatar, and `availableForWork` gates
   * Direct). Grouped into one optional object so context-free callers pass nothing. Absent →
   * context-free rendering.
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
  /**
   * BAL-582 (§3b) — hero-provided text/product prefill, applied ONCE PER OPEN by
   * `useProjectSeed`. Existing mounts pass nothing (AC8): no seed, no behaviour change. Fresh
   * search text replaces the autosaved draft's; a reopen with the same search text keeps any edit
   * made in the panel (`seedTextPatch`).
   */
  seed?: ProjectRequestSeed;
  /**
   * BAL-582 (D1 return path, home mount only) — true when this open is the post-sign-up-and-
   * onboarding return to a saved draft. Opens at `manual` (or `upload` for an `'ai'`-sourced
   * draft, which was gated at upload) instead of `start`.
   */
  resumeDraft?: boolean;
  /**
   * BAL-582 (D1) — present means the caller is signed out. Submit and the document uploader
   * (both steps) call this instead of acting, so the auth modal is requested only at those two
   * points; the taxonomy self-load and the localStorage draft work signed out. Absent (existing
   * mounts) → unchanged, authenticated behaviour.
   */
  onAuthRequired?: () => void;
  /**
   * BAL-591 — the routing this open starts on, applied ONCE PER OPEN for an expert-bound mount
   * (the public profile's paused card opens on `match`). Omitted → the draft's own routing, which
   * defaults to Direct. A programmatic default, so it fires no `ROUTING_SWITCHED`; the server
   * still guards Direct regardless of what the panel opens on.
   */
  initialRouting?: ProjectRouting;
  /**
   * BAL-589 — present means this is a "Convert to project" mount, bound to the case's own
   * expert: `entryPoint` is `'case'`, the draft key is `balo:project-draft:case:{id}` (checked
   * before the expert key), the mount opens straight at `manual` with no `start`/`upload` step,
   * and the manual step auto-drafts a brief from the case's history instead of offering a
   * choice of entry path (`useCaseBriefFlow`).
   */
  sourceCase?: ProjectRequestSourceCase;
}

/** Mutable steps for the stepper (the readonly `as const` tuple isn't assignable). */
const STEPPER_STEPS = PROJECT_STEPS.map((s) => ({ key: s.key, label: s.label }));
/** BAL-254 — the AI branch's stepper array, same mutability fix. */
const STEPPER_STEPS_AI = PROJECT_STEPS_AI.map((s) => ({ key: s.key, label: s.label }));
/** BAL-589 — the case mount's two-dot stepper (no `start`, no `upload`), same mutability fix. */
const STEPPER_STEPS_CASE = PROJECT_STEPS_CASE.map((s) => ({ key: s.key, label: s.label }));

/** BAL-254 — the progressive wait-state heading, indexed by `useProjectBriefGeneration`'s
 *  `headingIndex` (0s / 5s / 15s). Caps at the last message past 15s. */
const GENERATING_HEADINGS = [
  'Reading your documents…',
  'Drafting your brief…',
  'Almost there…',
] as const;

const DESCRIPTION_PLACEHOLDER_SUFFIX = ' later.';

/**
 * The unmatched-label hints belong to an AI-generated brief. `useAiBriefFlow` keeps them in its
 * own state for the life of the mount, so once a new hero search has started a fresh (manual)
 * draft they must not resurface on its review step.
 */
const NO_UNMATCHED_LABELS: { tags: string[]; products: string[] } = { tags: [], products: [] };

/** The unmatched-label hints to show for a draft: its AI brief's, or none for a manual draft. */
function unmatchedLabelsFor(
  source: ProjectDraft['source'],
  labels: { tags: string[]; products: string[] }
): { tags: string[]; products: string[] } {
  return source === 'ai' ? labels : NO_UNMATCHED_LABELS;
}

/** An upload flag only counts for the draft revision whose uploader set it. */
function uploadingFor(state: { revision: number; value: boolean }, revision: number): boolean {
  return state.revision === revision && state.value;
}

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
  /** The hint under the optional budget fields. */
  budgetHint: string;
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
  budgetHint: 'Helps your expert scope and price the work.',
  submitCta: 'Find me an expert',
  successDescription: "We'll introduce a matched expert soon.",
  doneHeading: "Request sent — we're finding your expert",
  doneBody:
    "Our team will review your brief and introduce a matched expert, usually within a day. We'll email you and notify you in-app.",
  reviewReassurance:
    'Our team reviews briefs within a day and introduces a matched expert. No charge to send.',
};

/**
 * Routing-aware copy. The Direct copy is only used when an expert is bound (a
 * context-free mount is always Match), so `firstName` is always defined on the
 * Direct branch.
 */
function getRoutingCopy(routing: ProjectRouting, firstName: string | undefined): RoutingCopy {
  if (routing === 'direct' && firstName !== undefined) {
    return {
      manualHeading: null,
      formDescription: `${firstName} will review your brief and reply with a proposal.`,
      budgetHint: `Helps ${firstName} scope and price the work.`,
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
 * BAL-589 — what `source`/`method` the submit actually records. A case mount's
 * `draft.source` stays `'manual'` forever (the case flow never sets it), so this reads
 * `caseBriefFlow.hasAiDraft` instead; every other mount keeps reading `draft.source` as before.
 */
function resolveSubmitSource(
  isCaseMount: boolean,
  hasCaseAiDraft: boolean,
  draftSource: ProjectDraft['source']
): 'manual' | 'ai' {
  if (isCaseMount) return hasCaseAiDraft ? 'ai' : 'manual';
  return draftSource === 'ai' ? 'ai' : 'manual';
}

/**
 * BAL-589 — `brief_edited` on `PROJECT_REQUEST_SUBMITTED`: the ACTIVE AI-ish flow's own
 * edits-since-generate, never both at once (a mount is either case-bound or not), and `false`
 * when no AI draft of either kind ever landed.
 */
function resolveBriefEdited(
  isCaseMount: boolean,
  caseHasEdits: boolean,
  draftSource: ProjectDraft['source'],
  aiHasEdits: boolean
): boolean {
  if (isCaseMount) return caseHasEdits;
  if (draftSource === 'ai') return aiHasEdits;
  return false;
}

/**
 * BAL-589 — everything `CaseBriefField` + `CaseFilePicker` need, or `undefined` off a case
 * mount. Extracted (rather than an inline ternary in the component body) so SonarCloud's
 * cognitive-complexity count lands on this small, obviously-correct function instead of
 * `ProjectRequestPanel` itself.
 */
function buildCaseBriefBundle(
  sourceCase: ProjectRequestSourceCase | undefined,
  flow: UseCaseBriefFlowResult,
  draft: Pick<ProjectDraft, 'documents' | 'caseFileSelections'>,
  setField: SetProjectDraftField
): CaseBriefBundle | undefined {
  if (sourceCase === undefined) return undefined;
  return {
    sourceCase,
    phase: flow.phase,
    failureReason: flow.failureReason,
    revealedHtml: flow.revealedHtml,
    hasAiDraft: flow.hasAiDraft,
    onRedraftClick: flow.handleRedraftClick,
    onRetry: flow.handleRetry,
    onDismissFailure: flow.dismissFailure,
    uploadedDocumentCount: draft.documents.length,
    caseFileSelections: draft.caseFileSelections,
    onCaseFileSelectionsChange: (updater) => setField('caseFileSelections', updater),
  };
}

/** BAL-589 — "Continue" (manual → review) is disabled while a case brief is drafting or
 *  revealing; extracted for the same complexity reason as {@link buildCaseBriefBundle}. */
function isCaseBriefWorking(isCaseMount: boolean, phase: CaseBriefPhase): boolean {
  if (!isCaseMount) return false;
  return phase === 'generating' || phase === 'revealing';
}

interface RegenerateDialogConfig {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * BAL-589 — the "replace my edits?" confirm dialog is shared chrome; only its copy and
 * the flow it drives differ between a case mount (`useCaseBriefFlow`'s redraft) and the AI
 * upload path (`useAiBriefFlow`'s regenerate). Extracted for the same complexity reason as
 * {@link buildCaseBriefBundle}.
 */
function resolveRegenerateDialog(
  isCaseMount: boolean,
  caseBriefFlow: UseCaseBriefFlowResult,
  aiRegenerate: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }
): RegenerateDialogConfig {
  if (isCaseMount) {
    return {
      open: caseBriefFlow.regenerateConfirmOpen,
      onOpenChange: caseBriefFlow.setRegenerateConfirmOpen,
      title: 'Redraft from case?',
      body: 'Replace your edits with a fresh draft from the case?',
      confirmLabel: 'Redraft',
      onConfirm: caseBriefFlow.handleConfirmRedraft,
    };
  }
  return {
    open: aiRegenerate.open,
    onOpenChange: aiRegenerate.onOpenChange,
    title: 'Regenerate the brief?',
    body: "This replaces your edits with a new draft from the same documents. Your edits won't be recoverable.",
    confirmLabel: 'Regenerate',
    onConfirm: aiRegenerate.onConfirm,
  };
}

/** The expert id a mount routes to — defined only when the display data for that expert is too. */
function boundExpertId(
  expertProfileId: string | undefined,
  expert: ProjectRequestExpert | undefined
): string | undefined {
  return expert ? expertProfileId : undefined;
}

/**
 * The review step's "expert isn't taking on new work" notice — rendered only while Direct is
 * blocked for a named expert.
 */
function unavailableNoticeFor(
  directBlocked: boolean,
  firstName: string | undefined,
  onMatchInstead: () => void
): React.ReactNode {
  if (!directBlocked || firstName === undefined) return undefined;
  return <ExpertUnavailableNotice firstName={firstName} onMatchInstead={onMatchInstead} />;
}

/**
 * BAL-254 — the AI branch's stepper: same three dots, middle one relabelled + rekeyed. While on
 * `manual` WITH `source === 'ai'` (arrived via an Edit link), keep the AI array but report
 * `upload` as current so the middle dot stays lit.
 *
 * ⚠ EXTRACTED so the decision lives in ONE place rather than as scattered conditionals inside the
 * panel.
 */
function resolveStepper(
  isCaseMount: boolean,
  isAiPath: boolean,
  step: ProjectStep
): { steps: { key: string; label: string }[]; current: ProjectStep } {
  if (isCaseMount) return { steps: STEPPER_STEPS_CASE, current: step };
  if (!isAiPath) return { steps: STEPPER_STEPS, current: step };
  return { steps: STEPPER_STEPS_AI, current: step === 'manual' ? 'upload' : step };
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
 *    to Direct, the selector/copy bind to the expert, submit sends `direct`. A
 *    text toggle switches to Match and back without touching any field; Direct
 *    is blocked while the expert isn't taking on new work.
 *  - **Context-free** (no expert): routing is always Match, the selector is a
 *    static block, submit sends `match`.
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
  seed,
  resumeDraft,
  onAuthRequired,
  initialRouting,
  sourceCase,
}: Readonly<ProjectRequestPanelProps>): React.JSX.Element {
  // BAL-589 — true only for a "Convert to project" mount. Read before everything else: the
  // draft key, the opening step and the stepper all branch on it.
  const isCaseMount = sourceCase !== undefined;
  // A mount is expert-bound only when it has both the id and the display data, so the draft key,
  // the routing and the submit all agree on whether a recipient card is on screen.
  const boundExpertProfileId = boundExpertId(expertProfileId, expert);
  // Read before the step state: it reads only props, and the step initialiser below needs
  // `draft.source` to decide a resumed mount's opening step.
  const { draft, setField, clearDraft, resetDraft, replaceDraft, revision } = useProjectDraft(
    boundExpertProfileId,
    entryPoint,
    sourceCase?.id
  );
  const { routing, title, descriptionHtml, tagIds, productIds, budgetMinCents, budgetMaxCents } =
    draft;

  const resumeDraftBool = resumeDraft === true;
  const [step, setStep] = useState<ProjectStep>(() =>
    open ? initialStepFor(seed, resumeDraftBool, draft.source, isCaseMount) : 'start'
  );
  // The step this open resolved to (`initialStepFor`'s answer), read by the `step_viewed` effect
  // so a lazily-mounted already-open panel — or a reopen onto a fresh `initialStepFor` result —
  // fires exactly one STEP_VIEWED, for the OPENING step, never a stale render-time step.
  const openingStepRef = useRef<ProjectStep | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  // ⚠ UPLOAD STATE IS PER DRAFT REVISION. A new hero search's fresh start and its Undo replace the
  // draft wholesale (bumping `revision`) while an upload begun under the replaced draft may still
  // be in flight — `DocumentUploader` keeps publishing after it unmounts. Each update is tagged
  // with the revision its uploader was rendered under and dropped once that revision is gone, so
  // the replaced draft's files never land in the fresh draft (or over the restored one).
  const [uploadingState, setUploadingState] = useState({ revision, value: false });
  const uploading = uploadingFor(uploadingState, revision);
  // ⚠⚠ `useLayoutEffect`, NOT `useEffect` — the ref must be current before ANY passive effect
  // (including an unmounting `DocumentUploader`'s own cleanup) can run. Passive effects for a
  // commit run strictly after all of that commit's layout effects, so a plain `useEffect` here left
  // a real, if narrow, gap: a `resetDraft`/`replaceDraft` bumps `revision` and this ref updates in
  // the SAME commit's passive-effect pass — but an orphaned uploader's own unmount cleanup (also
  // passive) could fire in that same pass BEFORE this one does, still see the OLD `revisionRef`,
  // and pass `uploadHandlers`' guard with a STALE closed-over `revision` that happened to still
  // equal it — writing the replaced draft's files into the fresh one. A layout effect closes the
  // gap entirely: it runs synchronously in the commit phase, before any passive effect at all.
  const revisionRef = useRef(revision);
  useLayoutEffect(() => {
    revisionRef.current = revision;
  }, [revision]);
  // Snapshot of the routing at submit time — the done screen + success toast read
  // this, NOT the live draft (which `clearDraft()` resets on success).
  const expertBound = boundExpertProfileId !== undefined;
  const [submittedRouting, setSubmittedRouting] = useState<ProjectRouting>(
    expertBound ? 'direct' : 'match'
  );

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

  const { effectiveExpert, unavailableTrigger, markUnavailable, resetOverride } =
    useExpertUnavailableOverride(expert);

  const { directBlocked, changeRouting, matchInsteadFromReview, submitButtonRef } =
    useProjectRouting({
      open,
      step,
      routing,
      expertProfileId: boundExpertProfileId,
      expertAvailableForWork: effectiveExpert?.availableForWork,
      unavailableTrigger,
      entryPoint,
      setRouting: (r) => setField('routing', r),
    });

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
    const openStep = initialStepFor(seed, resumeDraftBool, draft.source, isCaseMount);
    openingStepRef.current = openStep;
    setStep(openStep);
    setError(null);
    setShowValidation(false);
    resetOverride();
    if (initialRouting !== undefined && boundExpertProfileId !== undefined) {
      setField('routing', initialRouting);
    }
    // Fires for every mount mode; `expert_id` is included only when the mount is expert-bound.
    track(
      PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
      projectFunnelDimensions(expertProfileId, entryPoint)
    );
    // Context-free self-load: taxonomies were not RSC-supplied, so fetch them once
    // on first open (reusing the Retry path + the picker's loading/error UI).
    if (projectTaxonomies === undefined && !selfLoadedRef.current) {
      selfLoadedRef.current = true;
      handleRetryTaxonomies().catch(() => {});
    }
  }, [
    open,
    seed,
    resumeDraftBool,
    draft.source,
    isCaseMount,
    expertProfileId,
    entryPoint,
    projectTaxonomies,
    handleRetryTaxonomies,
    initialRouting,
    boundExpertProfileId,
    setField,
    resetOverride,
  ]);

  // `step_viewed` on every step change while open, for every mount mode (BAL-582 D2). Skips the
  // stale render-time step captured by the SAME effect flush that the open effect (above) just
  // redirected away from — see `openingStepRef`'s docblock — so a reopen fires exactly one
  // STEP_VIEWED, for the opening step, never the step the panel happened to be showing before.
  useEffect(() => {
    if (!open) return;
    const pending = openingStepRef.current;
    if (pending !== null) {
      if (step !== pending) return;
      openingStepRef.current = null;
    }
    track(PROJECT_EVENTS.PROJECT_STEP_VIEWED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
      step,
    });
  }, [open, step, expertProfileId, entryPoint]);

  // ⚠ Closing the drawer does not unmount this component, so a parse that lands after the
  // user has closed it, or after they have submitted, must write nothing. Computed ONCE and
  // shared by both brief flows below (rather than repeating the expression) so SonarCloud's
  // cognitive-complexity count sees one `&&`, not two.
  const isFlowActive = open && step !== 'done';

  const {
    briefGeneration,
    isGenerating,
    isUploadFailed,
    unmatchedLabels,
    hasEditsSinceGenerate: aiHasEditsSinceGenerate,
    regenerateConfirmOpen,
    setRegenerateConfirmOpen,
    handleSelectAi,
    cancelGeneration,
    handleGenerateClick,
    handleRetryGenerate,
    handleWriteItMyself,
    handleRegenerateClick,
    handleConfirmRegenerate,
    capturedAiState,
    clearAiState,
    restoreAiState,
  } = useAiBriefFlow({
    expertProfileId,
    entryPoint,
    draft,
    setField,
    setStep,
    isFlowActive,
  });

  // BAL-589 — the case-history sibling of the AI flow above. INERT when `sourceCase` is
  // `undefined` (every non-case mount) — see the hook's own docblock. Called unconditionally,
  // alongside `useAiBriefFlow`, because hooks can never be called conditionally.
  const caseBriefFlow = useCaseBriefFlow({
    sourceCase,
    open,
    isFlowActive,
    draft,
    setField,
  });

  // BAL-582 (§3b) — applies the hero seed to the draft once per open (never sets `step`). Threads
  // the AI flow's capture/clear/restore trio so a fresh start (and its Undo) carries the AI
  // generation along with the draft fields — see `AiGeneratedState`'s docblock.
  const newRequestUndo = useProjectSeed({
    open,
    seed,
    draft,
    setField,
    resetDraft,
    replaceDraft,
    productsTaxonomy: taxonomies.products,
    capturedAiState,
    clearAiState,
    restoreAiState,
    expertProfileId,
    entryPoint,
  });

  // Clear any stale submit error once the user leaves the review step.
  useEffect(() => {
    if (step !== 'review') setError(null);
  }, [step]);

  // Focus the title field when (and only when) the manual step becomes active — INCLUDING when
  // `revision` bumps while already on it. `ProjectRequestDrawerBody` is `key={revision}`, so an
  // Undo (or a fresh search that lands straight on `manual`) remounts it and creates a BRAND NEW
  // title input while `step` itself never changes — an effect keyed on `[step]` alone never re-ran
  // to claim focus on that new element, and the focus Undo's own button held fell to the drawer's
  // dialog container instead.
  useEffect(() => {
    if (step === 'manual') titleInputRef.current?.focus();
  }, [step, revision]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleSelectManual = useCallback(() => {
    track(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
      method: 'manual',
    });
    // ⚠⚠ BAL-254 W2 — CANCEL ANY IN-FLIGHT GENERATION FIRST. `isFlowActive` (F5) is false only
    // once the drawer is closed or the request is submitted — a user who started a generate, went
    // Back to `start`, and picked "I'll write it myself" is still an ACTIVE flow, so the parse
    // kept polling and a late success wrote all four AI fields over their hand-typed draft and
    // force-navigated them to `review`. Cancelling is explicit and also stops the wasted polling.
    cancelGeneration();
    // ⚠ FIX ROUND F14 — RESET `source`. Picking "I'll write it myself" from the start step is a
    // claim about THIS draft, and it has to overwrite an earlier `'ai'` choice: a user who tried
    // the AI path, went Back, and then typed the brief by hand was being recorded as `source:
    // 'ai'` at submit, silently corrupting the AI-vs-manual metric this ticket exists to measure
    // (and rendering the AI provenance banner over a hand-typed brief).
    setField('source', 'manual');
    setStep('manual');
  }, [expertProfileId, entryPoint, setField, cancelGeneration]);

  const handleJump = useCallback((key: string) => {
    if (key === 'start' || key === 'upload' || key === 'manual' || key === 'review') setStep(key);
  }, []);

  const handleGoReview = useCallback(() => {
    setShowValidation(true);
    if (reviewValid) setStep('review');
  }, [reviewValid]);

  const uploadHandlers = useMemo(
    () => ({
      onDocumentsChange: (docs: ProjectDraft['documents']) => {
        if (revision === revisionRef.current) setField('documents', docs);
      },
      onUploadingChange: (value: boolean) => {
        if (revision === revisionRef.current) setUploadingState({ revision, value });
      },
    }),
    [revision, setField]
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
    // BAL-582 (D1) — the ONLY auth gate on Submit. Signed out (`onAuthRequired` present) requests
    // sign-in instead of acting; the draft is untouched, so the same click submits once signed in.
    if (onAuthRequired) {
      onAuthRequired();
      return;
    }
    setSubmitting(true);
    setError(null);

    const effectiveSource = resolveSubmitSource(
      isCaseMount,
      caseBriefFlow.hasAiDraft,
      draft.source
    );
    // ⚠ Every document the request carries: the uploader's own PLUS every
    // case-file copy, which `draft.documents` alone never holds (see `allDraftDocuments`).
    const submittedDocuments = allDraftDocuments({
      documents: draft.documents,
      caseFileSelections: draft.caseFileSelections,
    });
    const base = {
      title: trimmedTitle,
      description: descriptionHtml,
      tagIds,
      productIds,
      documents: submittedDocuments,
      source: effectiveSource,
      sourceCaseId: sourceCase?.id,
      budgetMinCents: draft.budgetMinCents,
      budgetMaxCents: draft.budgetMaxCents,
      timeline: draft.timeline,
    };
    // Guard: only emit `direct` for an expert-bound mount. Routing already follows the entry
    // point, so a missing binding (never `direct` in practice) falls back to `match`.
    const sendDirect = boundExpertProfileId !== undefined && routing === 'direct';
    const payload = sendDirect
      ? { sendTo: 'direct' as const, expertProfileId: boundExpertProfileId, ...base }
      : { sendTo: 'match' as const, ...base };
    // The routing actually submitted (clamped) — drives the done screen + toast.
    const effectiveRouting: ProjectRouting = sendDirect ? 'direct' : 'match';

    const result = await submitProjectRequestAction(payload);
    setSubmitting(false);

    if (!result.success && result.code === 'expert_unavailable') {
      // Not an error to dismiss: the unavailable notice renders in the form and on review, with
      // "Get matched instead" as the way forward.
      markUnavailable();
      return;
    }

    if (!result.success) {
      const message = result.error ?? 'Something went wrong. Please try again.';
      setError(message);
      toast.error(message);
      return;
    }

    track(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
      send_to: effectiveRouting,
      tag_count: tagIds.length,
      product_count: productIds.length,
      document_count: submittedDocuments.length,
      method: effectiveSource,
      source_case_id: sourceCase?.id,
      brief_edited: resolveBriefEdited(
        isCaseMount,
        caseBriefFlow.hasEditsSinceGenerate,
        draft.source,
        aiHasEditsSinceGenerate
      ),
    });
    // Snapshot routing for the done screen BEFORE clearing the draft (clear resets
    // routing to the computed default), so Match submits keep their done copy.
    setSubmittedRouting(effectiveRouting);
    clearDraft();
    const successCopy = getRoutingCopy(effectiveRouting, expertFirstName);
    toast.success('Request sent', { description: successCopy.successDescription });
    setStep('done');
    if (result.projectRequestId !== undefined) onSubmitted?.(result.projectRequestId);
  }, [
    markUnavailable,
    routing,
    boundExpertProfileId,
    expertProfileId,
    entryPoint,
    expertFirstName,
    trimmedTitle,
    descriptionHtml,
    tagIds,
    productIds,
    draft.documents,
    draft.caseFileSelections,
    draft.budgetMinCents,
    draft.budgetMaxCents,
    draft.timeline,
    draft.source,
    isCaseMount,
    sourceCase?.id,
    caseBriefFlow.hasAiDraft,
    caseBriefFlow.hasEditsSinceGenerate,
    aiHasEditsSinceGenerate,
    clearDraft,
    onSubmitted,
    onAuthRequired,
  ]);

  // ⚠ `isGenerating` (fix round F5). Submitting mid-REGENERATE reached `done`, and then the
  // still-running poll's success handler repopulated the just-cleared draft and pulled the user
  // back to `review` from the confirmation screen. The abandoned-flow guard in `useAiBriefFlow`
  // is the belt; this is the braces — the button is simply not live while a draft is being
  // rewritten under it.
  const submitDisabled = !reviewValid || submitting || uploading || isGenerating || directBlocked;

  const startHeading = expert ? `Start a project with ${expert.name}` : 'Start a project';
  const startBody =
    expertFirstName === undefined
      ? "Tell us what you need and we'll match you with the right expert. Pick how you'd like to begin — it only takes a minute or two."
      : `Tell us what you need and ${expertFirstName} replies with a scoped proposal. Pick how you'd like to begin — it only takes a minute or two.`;

  const descriptionRefinePerson =
    expertFirstName === undefined ? 'with your expert' : `with ${expertFirstName}`;

  // BAL-589 — everything `CaseBriefField` + `CaseFilePicker` need, bundled into one optional
  // prop so `ManualStepFields` gains exactly one new prop rather than a dozen case-only ones.
  // `undefined` on every non-case mount.
  const caseBriefBundle = buildCaseBriefBundle(sourceCase, caseBriefFlow, draft, setField);

  const manualBody = (
    <ManualStepFields
      notice={newRequestUndo === null ? undefined : <NewRequestNotice {...newRequestUndo} />}
      onBack={() => setStep('start')}
      manualHeading={copy.manualHeading}
      formDescription={copy.formDescription}
      budgetHint={directBlocked ? MATCH_COPY.budgetHint : copy.budgetHint}
      routing={routing}
      onRoutingChange={changeRouting}
      expert={effectiveExpert}
      titleInputRef={titleInputRef}
      title={title}
      onTitleChange={(v) => setField('title', v)}
      showValidation={showValidation}
      titleValid={titleValid}
      trimmedTitle={trimmedTitle}
      descriptionHtml={descriptionHtml}
      onDescriptionChange={(html) => setField('descriptionHtml', html)}
      descriptionPlaceholder={`Describe the problem or the outcome you're after — bullet points are fine. You can refine it ${descriptionRefinePerson}${DESCRIPTION_PLACEHOLDER_SUFFIX}`}
      descriptionError={descriptionError}
      taxonomies={taxonomies}
      tagIdSet={tagIdSet}
      tagNameMap={tagNameMap}
      onToggleTag={toggleTag}
      onClearTags={() => setField('tagIds', [])}
      tagsLoading={retrying && taxonomies.tags.groups.length === 0}
      tagsError={tagsError}
      productIdSet={productIdSet}
      productNameMap={productNameMap}
      onToggleProduct={toggleProduct}
      onClearProducts={() => setField('productIds', [])}
      productsLoading={retrying && taxonomies.products.groups.length === 0}
      productsError={productsError}
      onRetryTaxonomies={handleRetryTaxonomies}
      documents={draft.documents}
      onDocumentsChange={uploadHandlers.onDocumentsChange}
      onUploadingChange={uploadHandlers.onUploadingChange}
      onRequireAuth={onAuthRequired}
      budgetMinCents={budgetMinCents}
      budgetMaxCents={budgetMaxCents}
      budgetRangeInvalid={budgetRangeInvalid}
      budgetDollarsValue={budgetDollarsValue}
      onBudgetChange={handleBudgetChange}
      timeline={draft.timeline}
      onTimelineChange={handleTimelineChange}
      caseBrief={caseBriefBundle}
    />
  );

  const isAiPath = draft.source === 'ai';
  const { steps: stepperSteps, current: stepperCurrent } = resolveStepper(
    isCaseMount,
    isAiPath,
    step
  );

  // ⚠ `isGenerating ||` REMOVED (fix round F5/#17). It was dead: `phase` is one of
  // `idle | generating | failed`, so `isGenerating` already implies `!isUploadFailed`. The
  // banner shows unless the last generation failed.
  const aiBanner =
    isAiPath && !isUploadFailed ? (
      <AiProvenanceBanner
        isGenerating={isGenerating}
        onRegenerate={handleRegenerateClick}
        onChangeSourceDocuments={() => setStep('upload')}
      />
    ) : undefined;

  // BAL-589 — "Continue" (manual → review) is disabled while a case brief is still drafting or
  // revealing; the AI path has no equivalent (its own step, `upload`, already blocks on
  // `isGenerating`).
  const caseBriefWorking = isCaseBriefWorking(isCaseMount, caseBriefFlow.phase);

  // BAL-589 — the "replace my edits?" confirm dialog is shared chrome; only its copy and
  // the flow it drives differ between a case mount (`useCaseBriefFlow`'s redraft) and the AI
  // upload path (`useAiBriefFlow`'s regenerate).
  const regenerateDialog = resolveRegenerateDialog(isCaseMount, caseBriefFlow, {
    open: regenerateConfirmOpen,
    onOpenChange: setRegenerateConfirmOpen,
    onConfirm: handleConfirmRegenerate,
  });

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
            <FlowStepper steps={[...stepperSteps]} current={stepperCurrent} onJump={handleJump} />
          )}
        </DrawerHeader>

        {/* ⚠ KEYED ON `revision`: a new hero search starts a fresh draft and its Undo restores
            the earlier one, each replacing the draft wholesale. `DocumentUploader` NEEDS this: it
            reads `initialDocuments` only on mount, so without a remount it would keep listing the
            replaced draft's files — and, since it REPLACES on change, write them back.

            ⚠ The key remounts EVERYTHING under this node, not just the uploaders — including
            `RichTextEditor` and `TaxonomyMultiSelect`. Neither NEEDS it: `RichTextEditor` already
            re-syncs from an externally-reset `value` prop via its own effect (the same one
            `clearDraft` relies on), and `TaxonomyMultiSelect` is a plain controlled selection with
            no mount-only read. Their remount only resets transient internal-only state (undo
            history, an open dropdown) that a wholesale draft replacement should reasonably clear
            anyway — so this stays a section-wide key rather than one scoped to just the uploaders,
            but say so here explicitly: narrowing it is a real option if that transient-state reset
            is ever unwanted, not an oversight that this comment used to imply didn't exist. */}
        <ProjectRequestDrawerBody
          key={revision}
          step={step}
          startHeading={startHeading}
          startBody={startBody}
          onSelectManual={handleSelectManual}
          onSelectAi={handleSelectAi}
          onBackToUploadEntry={() => setStep('start')}
          manualBody={manualBody}
          isGenerating={isGenerating}
          isUploadFailed={isUploadFailed}
          headingIndex={briefGeneration.headingIndex}
          failureReason={briefGeneration.failureReason}
          onDocumentsChange={uploadHandlers.onDocumentsChange}
          onUploadingChange={uploadHandlers.onUploadingChange}
          onRequireAuth={onAuthRequired}
          onRetryGenerate={handleRetryGenerate}
          onWriteItMyself={handleWriteItMyself}
          draft={draft}
          expert={effectiveExpert}
          tagNameMap={tagNameMap}
          productNameMap={productNameMap}
          onEditReview={() => setStep('manual')}
          aiBanner={aiBanner}
          unmatchedLabels={unmatchedLabelsFor(draft.source, unmatchedLabels)}
          isAiPath={isAiPath}
          onDismissRegenerateFailure={briefGeneration.dismissFailure}
          reviewReassurance={copy.reviewReassurance}
          unavailableNotice={unavailableNoticeFor(
            directBlocked,
            expertFirstName,
            matchInsteadFromReview
          )}
          uploading={uploading}
          error={error}
          submittedRouting={submittedRouting}
          doneHeading={doneCopy.doneHeading}
          doneBody={doneCopy.doneBody}
          sourceCase={sourceCase}
        />

        <ProjectRequestDrawerFooter
          step={step}
          onBackToStart={() => setStep('start')}
          onGoReview={handleGoReview}
          isGenerating={isGenerating}
          documentCount={draft.documents.length}
          uploading={uploading}
          onGenerateClick={handleGenerateClick}
          onBackFromReview={() => setStep(isAiPath ? 'upload' : 'manual')}
          submitting={submitting}
          onSubmit={handleSubmit}
          submitDisabled={submitDisabled}
          submitButtonRef={submitButtonRef}
          routing={routing}
          submitCta={copy.submitCta}
          onDone={handleClose}
          isCaseMount={isCaseMount}
          caseBriefWorking={caseBriefWorking}
        />
      </div>

      <Dialog open={regenerateDialog.open} onOpenChange={regenerateDialog.onOpenChange}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{regenerateDialog.title}</DialogTitle>
            <DialogDescription>{regenerateDialog.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => regenerateDialog.onOpenChange(false)}>
              Keep my edits
            </Button>
            <Button onClick={regenerateDialog.onConfirm}>{regenerateDialog.confirmLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Drawer>
  );
}

interface ProjectRequestDrawerBodyProps {
  step: ProjectStep;
  startHeading: string;
  startBody: string;
  onSelectManual: () => void;
  onSelectAi: () => void;
  onBackToUploadEntry: () => void;
  manualBody: React.ReactNode;
  isGenerating: boolean;
  isUploadFailed: boolean;
  headingIndex: 0 | 1 | 2;
  failureReason: ProjectBriefFailureReason | null;
  onDocumentsChange: (docs: ProjectDraft['documents']) => void;
  onUploadingChange: (uploading: boolean) => void;
  /** BAL-582 (D1) — present means signed out; passed through to the upload step's uploader. */
  onRequireAuth?: () => void;
  onRetryGenerate: () => void;
  onWriteItMyself: () => void;
  draft: ProjectDraft;
  expert?: ProjectRequestExpert;
  tagNameMap: Record<string, string>;
  productNameMap: Record<string, string>;
  onEditReview: () => void;
  aiBanner: React.ReactNode;
  unmatchedLabels: { tags: string[]; products: string[] };
  isAiPath: boolean;
  onDismissRegenerateFailure: () => void;
  reviewReassurance: string;
  /** Shown after the review summary when Direct is blocked (the expert isn't taking on new work). */
  unavailableNotice?: React.ReactNode;
  uploading: boolean;
  error: string | null;
  submittedRouting: ProjectRouting;
  doneHeading: string;
  doneBody: string;
  /** BAL-589 — present only on a case mount; drives the review/done steps' "Linked to case" copy. */
  sourceCase?: ProjectRequestSourceCase;
}

/**
 * BAL-254 — the drawer's per-step body content, extracted out of `ProjectRequestPanel` (whose
 * cognitive complexity exceeded the SonarCloud gate with all five steps' JSX inlined).
 */
function ProjectRequestDrawerBody({
  step,
  startHeading,
  startBody,
  onSelectManual,
  onSelectAi,
  onBackToUploadEntry,
  manualBody,
  isGenerating,
  isUploadFailed,
  headingIndex,
  failureReason,
  onDocumentsChange,
  onUploadingChange,
  onRequireAuth,
  onRetryGenerate,
  onWriteItMyself,
  draft,
  expert,
  tagNameMap,
  productNameMap,
  onEditReview,
  aiBanner,
  unmatchedLabels,
  isAiPath,
  onDismissRegenerateFailure,
  reviewReassurance,
  unavailableNotice,
  uploading,
  error,
  submittedRouting,
  doneHeading,
  doneBody,
  sourceCase,
}: Readonly<ProjectRequestDrawerBodyProps>): React.JSX.Element {
  return (
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
                onClick={path.key === 'manual' ? onSelectManual : onSelectAi}
              />
            ))}
          </div>
        </div>
      )}

      {step === 'manual' && manualBody}

      {step === 'upload' && (
        <div className="space-y-6 p-6">
          <button
            type="button"
            onClick={onBackToUploadEntry}
            className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Change entry method
          </button>

          <UploadStepBody
            isGenerating={isGenerating}
            headingIndex={headingIndex}
            documents={draft.documents}
            onDocumentsChange={onDocumentsChange}
            onUploadingChange={onUploadingChange}
            onRequireAuth={onRequireAuth}
            isUploadFailed={isUploadFailed}
            failureReason={failureReason}
            onRetryGenerate={onRetryGenerate}
            onWriteItMyself={onWriteItMyself}
          />
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4 p-6">
          <ReviewSummary
            draft={draft}
            expertName={expert?.name}
            expertInitials={expert?.initials}
            expertAvatarKey={expert?.avatarKey}
            tagNameMap={tagNameMap}
            productNameMap={productNameMap}
            onEdit={onEditReview}
            aiBanner={aiBanner}
            unmatchedTagLabels={unmatchedLabels.tags}
            unmatchedProductLabels={unmatchedLabels.products}
            skeleton={isAiPath && isGenerating}
            sourceCaseTitle={sourceCase?.title}
          />
          {unavailableNotice}
          {isAiPath && isUploadFailed && (
            <GenerationErrorBanner
              reason={failureReason ?? 'unknown'}
              variant="review"
              onDismiss={onDismissRegenerateFailure}
            />
          )}
          <p className="text-muted-foreground text-xs leading-relaxed">{reviewReassurance}</p>
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
          <h2 className="text-foreground text-xl font-semibold">{doneHeading}</h2>
          <p className="text-muted-foreground mx-auto mt-2.5 max-w-[340px] text-sm leading-relaxed">
            {doneBody}
          </p>
          {sourceCase !== undefined && (
            <p className="mt-4 text-sm">
              <Link
                href={`/cases/${sourceCase.id}`}
                className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md font-semibold focus-visible:ring-2 focus-visible:outline-none"
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                Linked to case: {sourceCase.title}
              </Link>
            </p>
          )}
        </div>
      )}
    </DrawerBody>
  );
}

/** The `upload` step's own body (dropzone / generating wait-state / failure banner). */
function UploadStepBody({
  isGenerating,
  headingIndex,
  documents,
  onDocumentsChange,
  onUploadingChange,
  onRequireAuth,
  isUploadFailed,
  failureReason,
  onRetryGenerate,
  onWriteItMyself,
}: Readonly<{
  isGenerating: boolean;
  headingIndex: 0 | 1 | 2;
  documents: ProjectDraft['documents'];
  onDocumentsChange: (docs: ProjectDraft['documents']) => void;
  onUploadingChange: (uploading: boolean) => void;
  /** BAL-582 (D1) — present means signed out. */
  onRequireAuth?: () => void;
  isUploadFailed: boolean;
  failureReason: ProjectBriefFailureReason | null;
  onRetryGenerate: () => void;
  onWriteItMyself: () => void;
}>): React.JSX.Element {
  return (
    <>
      <AnimatePresence initial={false}>
        {isGenerating && (
          <motion.div
            key="generating"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-center justify-center gap-4 py-14 text-center"
          >
            <span
              className="border-muted border-t-primary h-11 w-11 animate-spin rounded-full border-4"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <h2 className="text-foreground text-base font-semibold">
                {GENERATING_HEADINGS[headingIndex]}
              </h2>
              <p className="text-muted-foreground text-sm">
                Drafting a short brief you can check over and edit.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
        ⚠⚠ HIDDEN WHILE GENERATING, NEVER UNMOUNTED (fix round F16). `DocumentUploader` owns its
        file rows in its OWN state, so swapping it out for the spinner and back emptied the list:
        on a failure the user saw a bare dropzone directly underneath a banner promising "Your
        files are still attached." Keeping the subtree mounted makes the copy true again, and
        costs only the exit animation on the swap (the spinner still replaces it visually, as the
        design asks).

        ⚠⚠ AND IT IS **SEEDED** FROM `draft.documents` (BAL-254 W1). Staying mounted only covers
        the generating toggle WITHIN this step; the whole step unmounts on a step change, so
        review → "Change source documents" landed on an empty dropzone despite the draft holding
        files — and because `handleDocumentsChange` REPLACES rather than merges, adding one file
        there silently dropped the originals from both the parse input and the request's
        attachments. Seeding fixes that here and on the manual step's uploader alike.
      */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className={cn('space-y-4', isGenerating && 'hidden')}
      >
        <div className="space-y-2">
          <h2 className="text-foreground text-xl font-semibold tracking-[-0.01em]">
            Upload your project docs
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            RFPs, requirement docs, screenshots, or notes — we&apos;ll read them and draft a short
            brief for you to check over.
          </p>
        </div>
        <DocumentUploader
          initialDocuments={documents}
          onDocumentsChange={onDocumentsChange}
          onUploadingChange={onUploadingChange}
          onRequireAuth={onRequireAuth}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          These become both the draft&apos;s source material and your request&apos;s attachments —
          nothing else to upload later.
        </p>
        {documents.length === 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            Add at least one file to generate a brief.
          </p>
        )}
      </motion.div>

      {isUploadFailed && (
        <GenerationErrorBanner
          reason={failureReason ?? 'unknown'}
          variant="upload"
          onRetry={onRetryGenerate}
          onWriteItMyself={onWriteItMyself}
        />
      )}
    </>
  );
}

interface ProjectRequestDrawerFooterProps {
  step: ProjectStep;
  onBackToStart: () => void;
  onGoReview: () => void;
  isGenerating: boolean;
  documentCount: number;
  uploading: boolean;
  onGenerateClick: () => void;
  onBackFromReview: () => void;
  submitting: boolean;
  onSubmit: () => void;
  submitDisabled: boolean;
  submitButtonRef: React.Ref<HTMLButtonElement>;
  routing: ProjectRouting;
  submitCta: string;
  onDone: () => void;
  /** BAL-589 — a case mount's `manual` step has no `start` step to go back to. */
  isCaseMount: boolean;
  /** BAL-589 — true while the case brief is drafting or revealing; disables "Review". */
  caseBriefWorking: boolean;
}

/** The drawer's per-step footer, extracted for the same reason as {@link ProjectRequestDrawerBody}. */
function ProjectRequestDrawerFooter({
  step,
  onBackToStart,
  onGoReview,
  isGenerating,
  documentCount,
  uploading,
  onGenerateClick,
  onBackFromReview,
  submitting,
  onSubmit,
  submitDisabled,
  submitButtonRef,
  routing,
  submitCta,
  onDone,
  isCaseMount,
  caseBriefWorking,
}: Readonly<ProjectRequestDrawerFooterProps>): React.JSX.Element | null {
  if (step === 'manual') {
    return (
      <DrawerFooter className={isCaseMount ? 'justify-end' : undefined}>
        {!isCaseMount && <BackButton onClick={onBackToStart} />}
        <PrimaryButton onClick={onGoReview} disabled={caseBriefWorking}>
          Review <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </PrimaryButton>
      </DrawerFooter>
    );
  }

  if (step === 'upload') {
    return (
      <DrawerFooter>
        <BackButton onClick={onBackToStart} disabled={isGenerating} />
        <PrimaryButton
          onClick={onGenerateClick}
          disabled={documentCount === 0 || uploading || isGenerating}
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Generating…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden="true" /> Generate brief
            </>
          )}
        </PrimaryButton>
      </DrawerFooter>
    );
  }

  if (step === 'review') {
    return (
      <DrawerFooter>
        <BackButton onClick={onBackFromReview} disabled={submitting} />
        <PrimaryButton onClick={onSubmit} disabled={submitDisabled} buttonRef={submitButtonRef}>
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
              {submitCta}
            </>
          )}
        </PrimaryButton>
      </DrawerFooter>
    );
  }

  if (step === 'done') {
    return (
      <DrawerFooter className="justify-end">
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </DrawerFooter>
    );
  }

  return null;
}

interface ManualStepFieldsProps {
  /** Shown above everything else on the step — the new-request Undo (`NewRequestNotice`). */
  notice?: React.ReactNode;
  onBack: () => void;
  manualHeading: string | null;
  formDescription: string;
  budgetHint: string;
  routing: ProjectRouting;
  onRoutingChange: (r: ProjectRouting) => void;
  expert?: ProjectRequestExpert;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  title: string;
  onTitleChange: (value: string) => void;
  showValidation: boolean;
  titleValid: boolean;
  trimmedTitle: string;
  descriptionHtml: string;
  onDescriptionChange: (html: string) => void;
  descriptionPlaceholder: string;
  descriptionError: string | null;
  taxonomies: ProjectRequestTaxonomies;
  tagIdSet: Set<string>;
  tagNameMap: Record<string, string>;
  onToggleTag: (id: string) => void;
  onClearTags: () => void;
  tagsLoading: boolean;
  tagsError: boolean;
  productIdSet: Set<string>;
  productNameMap: Record<string, string>;
  onToggleProduct: (id: string) => void;
  onClearProducts: () => void;
  productsLoading: boolean;
  productsError: boolean;
  onRetryTaxonomies: () => void;
  /** BAL-254 W1 — seeds the uploader's rows so review → Edit → manual keeps the attachments. */
  documents: ProjectDraft['documents'];
  onDocumentsChange: (docs: ProjectDraft['documents']) => void;
  onUploadingChange: (uploading: boolean) => void;
  /** BAL-582 (D1) — present means signed out; passed through to this step's uploader. */
  onRequireAuth?: () => void;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  budgetRangeInvalid: boolean;
  budgetDollarsValue: (cents: number | null) => string;
  onBudgetChange: (key: 'budgetMinCents' | 'budgetMaxCents', raw: string) => void;
  timeline: string | null;
  onTimelineChange: (raw: string) => void;
  /** BAL-589 — present only on a case mount; see {@link CaseBriefBundle}. */
  caseBrief?: CaseBriefBundle;
}

/**
 * The `manual` step's field set (BAL-259, extended by BAL-254, BAL-589). Extracted out of
 * `ProjectRequestPanel` — inlined, its half-dozen independent validation/loading conditionals
 * pushed the panel's own cognitive complexity over the SonarCloud gate.
 */
function ManualStepFields({
  notice,
  onBack,
  manualHeading,
  formDescription,
  budgetHint,
  routing,
  onRoutingChange,
  expert,
  titleInputRef,
  title,
  onTitleChange,
  showValidation,
  titleValid,
  trimmedTitle,
  descriptionHtml,
  onDescriptionChange,
  descriptionPlaceholder,
  descriptionError,
  taxonomies,
  tagIdSet,
  tagNameMap,
  onToggleTag,
  onClearTags,
  tagsLoading,
  tagsError,
  productIdSet,
  productNameMap,
  onToggleProduct,
  onClearProducts,
  productsLoading,
  productsError,
  onRetryTaxonomies,
  documents,
  onDocumentsChange,
  onUploadingChange,
  onRequireAuth,
  budgetMinCents,
  budgetMaxCents,
  budgetRangeInvalid,
  budgetDollarsValue,
  onBudgetChange,
  timeline,
  onTimelineChange,
  caseBrief,
}: Readonly<ManualStepFieldsProps>): React.JSX.Element {
  const timelineHintId = useId();
  // Copies the picker reports as in-flight reserve a slot too, shrinking the
  // uploader's own `maxDocuments` by the same amount the picker already reserves for them.
  const [busyCopyCount, setBusyCopyCount] = useState(0);
  return (
    <div className="space-y-6 p-6">
      {notice}
      {caseBrief ? (
        <div className="bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium">
          <MessageSquare className="h-3 w-3" aria-hidden="true" />
          Converting this case to a project
        </div>
      ) : (
        <button
          type="button"
          onClick={onBack}
          className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Change entry method
        </button>
      )}

      {/* 2.1 — Send request to */}
      <div className="space-y-2">
        {manualHeading !== null && (
          <p className="text-foreground text-sm leading-relaxed font-medium">{manualHeading}</p>
        )}
        <FieldLabel>Send request to</FieldLabel>
        <SendToSelector
          value={routing}
          onChange={onRoutingChange}
          expert={expert}
          helperText={formDescription}
        />
      </div>

      {/* 2.2 — Title */}
      <div className="space-y-2">
        <InputFloating
          ref={titleInputRef}
          label="Project title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
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
      {caseBrief ? (
        <CaseBriefField
          bundle={caseBrief}
          descriptionHtml={descriptionHtml}
          onDescriptionChange={onDescriptionChange}
          descriptionError={descriptionError}
          showValidation={showValidation}
        />
      ) : (
        <div className="space-y-2">
          <FieldLabel>What do you need?</FieldLabel>
          <RichTextEditor
            value={descriptionHtml}
            onChange={onDescriptionChange}
            placeholder={descriptionPlaceholder}
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
      )}

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
          onToggle={onToggleTag}
          onClear={onClearTags}
          loading={tagsLoading}
          error={tagsError}
          onRetry={onRetryTaxonomies}
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
          {caseBrief
            ? 'Prefilled from your case. Change as needed.'
            : 'Which products does this touch? Same list as expert search.'}
        </p>
        <TaxonomyMultiSelect
          taxonomy={taxonomies.products}
          selectedIds={productIdSet}
          nameMap={productNameMap}
          onToggle={onToggleProduct}
          onClear={onClearProducts}
          loading={productsLoading}
          error={productsError}
          onRetry={onRetryTaxonomies}
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
        {caseBrief && (
          <CaseFilePicker
            caseId={caseBrief.sourceCase.id}
            files={caseBrief.sourceCase.files}
            uploadedDocumentCount={caseBrief.uploadedDocumentCount}
            caseFileSelections={caseBrief.caseFileSelections}
            onCaseFileSelectionsChange={caseBrief.onCaseFileSelectionsChange}
            onBusyCountChange={setBusyCopyCount}
          />
        )}
        <DocumentUploader
          initialDocuments={documents}
          onDocumentsChange={onDocumentsChange}
          onUploadingChange={onUploadingChange}
          onRequireAuth={onRequireAuth}
          // ⚠ On a case mount, every selected case-file copy reserves one of the
          // shared MAX_DOCUMENTS slots even though it never joins this uploader's own rows.
          // A copy still in flight reserves its slot too.
          maxDocuments={
            caseBrief
              ? MAX_DOCUMENTS - Object.keys(caseBrief.caseFileSelections).length - busyCopyCount
              : undefined
          }
        />
      </div>

      {/* 2.7 — Budget & timeline (optional) */}
      <div className="space-y-2">
        <FieldLabel optional>Budget &amp; timeline</FieldLabel>
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">{budgetHint}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InputFloating
            label="Min budget (A$)"
            inputMode="numeric"
            value={budgetDollarsValue(budgetMinCents)}
            onChange={(e) => onBudgetChange('budgetMinCents', e.target.value)}
            aria-invalid={budgetRangeInvalid}
          />
          <InputFloating
            label="Max budget (A$)"
            inputMode="numeric"
            value={budgetDollarsValue(budgetMaxCents)}
            onChange={(e) => onBudgetChange('budgetMaxCents', e.target.value)}
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
          aria-describedby={timelineHintId}
          value={timeline ?? ''}
          onChange={(e) => onTimelineChange(e.target.value)}
        />
        <p id={timelineHintId} className="text-muted-foreground text-xs">
          e.g. Go-live by end of Q3
        </p>
      </div>
    </div>
  );
}

interface CaseBriefFieldProps {
  bundle: CaseBriefBundle;
  descriptionHtml: string;
  onDescriptionChange: (html: string) => void;
  descriptionError: string | null;
  showValidation: boolean;
}

/**
 * An "editor-shaped" skeleton — a few pulsing bars the width of the real editor's text.
 *
 * ⚠ The heading is VISIBLE (not just `aria-label`), matching the AI-upload
 * path's own generating state (`GENERATING_HEADINGS`). The `aria-label` stays too: an accessible
 * name is computed from the author, never from content, so dropping it would silence screen
 * readers.
 *
 * ⚠ `<output>` (native), not `role="status"` (SonarCloud S6819 flags the ARIA
 * role where a native element already carries it), matching `(call)/meetings/[meetingId]/call/
 * loading.tsx`. `<output>` takes phrasing content only, so every child below is a `<span>`.
 */
function CaseBriefSkeleton(): React.JSX.Element {
  return (
    <output
      aria-label="Drafting a brief from your case…"
      className="border-border bg-card block space-y-3 rounded-lg border p-4"
    >
      <span className="text-foreground block text-sm font-semibold">
        Drafting a brief from your case…
      </span>
      <span className="block space-y-2">
        <span className="bg-muted block h-3.5 w-full animate-pulse rounded" aria-hidden="true" />
        <span className="bg-muted block h-3.5 w-full animate-pulse rounded" aria-hidden="true" />
        <span className="bg-muted block h-3.5 w-5/6 animate-pulse rounded" aria-hidden="true" />
        <span className="bg-muted block h-3.5 w-full animate-pulse rounded" aria-hidden="true" />
        <span className="bg-muted block h-3.5 w-2/3 animate-pulse rounded" aria-hidden="true" />
      </span>
    </output>
  );
}

/** "Redraft from case" is live only once a case brief has actually landed and
 *  nothing is in flight; disabled the rest of the time (including the auto-start's own
 *  `generating` phase, before `hasAiDraft` is even relevant). */
function canRedraftCaseBrief(hasAiDraft: boolean, phase: CaseBriefPhase): boolean {
  return hasAiDraft && (phase === 'idle' || phase === 'failed');
}

/** The helper line under a case mount's description field — working / drafted / nothing. */
function caseBriefHelperLine(working: boolean, hasAiDraft: boolean): string | null {
  if (working) return 'Summarising your case messages and call transcripts…';
  if (hasAiDraft) {
    return 'Drafted from your case history. Review and edit it, since it goes out under your name.';
  }
  return null;
}

/**
 * BAL-589 — the case mount's description field: a skeleton while `useCaseBriefFlow` is
 * generating, the progressive reveal while it is revealing, `GenerationErrorBanner` above an
 * empty editor on failure, and the plain editor otherwise (idle — a fresh success already
 * landed, or a resumed draft). Extracted out of `ManualStepFields` to keep the manual step's
 * (and this block's own) cognitive complexity under the SonarCloud gate.
 */
function CaseBriefField({
  bundle,
  descriptionHtml,
  onDescriptionChange,
  descriptionError,
  showValidation,
}: Readonly<CaseBriefFieldProps>): React.JSX.Element {
  const {
    phase,
    failureReason,
    revealedHtml,
    hasAiDraft,
    onRedraftClick,
    onRetry,
    onDismissFailure,
  } = bundle;
  const working = phase === 'generating' || phase === 'revealing';
  const helperLine = caseBriefHelperLine(working, hasAiDraft);
  const canRedraft = canRedraftCaseBrief(hasAiDraft, phase);

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <FieldLabel>What do you need?</FieldLabel>
        <div className="flex items-center gap-2">
          {hasAiDraft && (
            <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium">
              <Sparkles className="h-3 w-3" aria-hidden="true" /> AI draft
            </span>
          )}
          <button
            type="button"
            onClick={onRedraftClick}
            disabled={!canRedraft}
            className="text-primary hover:text-primary/80 focus-visible:ring-ring disabled:text-muted-foreground inline-flex items-center gap-1 rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed"
          >
            <RotateCw className="h-3 w-3" aria-hidden="true" /> Redraft from case
          </button>
        </div>
      </div>

      {phase === 'generating' && <CaseBriefSkeleton />}

      {phase === 'revealing' && revealedHtml !== null && <RichTextViewer value={revealedHtml} />}

      {(phase === 'idle' || phase === 'failed') && (
        <>
          {phase === 'failed' && (
            <GenerationErrorBanner
              reason={failureReason ?? 'unknown'}
              variant="case"
              onRetry={onRetry}
              onDismiss={onDismissFailure}
            />
          )}
          <RichTextEditor
            value={descriptionHtml}
            onChange={onDescriptionChange}
            placeholder="Describe the problem or the outcome you're after — bullet points are fine."
          />
          {showValidation && descriptionError !== null && (
            <p role="alert" className="text-destructive text-xs">
              {descriptionError}
            </p>
          )}
        </>
      )}

      {helperLine !== null && (
        <p className="text-muted-foreground text-xs leading-relaxed">{helperLine}</p>
      )}
    </div>
  );
}

/** BAL-254 — the `review` step's AI provenance banner (extracted for the panel's own complexity). */
function AiProvenanceBanner({
  isGenerating,
  onRegenerate,
  onChangeSourceDocuments,
}: Readonly<{
  isGenerating: boolean;
  onRegenerate: () => void;
  onChangeSourceDocuments: () => void;
}>): React.JSX.Element {
  return (
    <div className="border-primary/30 bg-primary/[0.04] flex flex-wrap items-center gap-3 rounded-xl border p-4">
      {isGenerating ? (
        <RotateCw className="text-primary h-4.5 w-4.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Sparkles className="text-primary h-4.5 w-4.5 shrink-0" aria-hidden="true" />
      )}
      <p className="text-foreground min-w-0 flex-1 text-sm font-medium">
        {isGenerating
          ? 'Regenerating your brief…'
          : 'AI-drafted from your documents — check over everything below.'}
      </p>
      {/*
        ⚠ 44px MINIMUM HIT AREA + A VISIBLE FOCUS RING ON BOTH CONTROLS (BAL-254 W5). Same rule
        F13 applied to the uploader's Retry/Remove in this PR, and the same reason: this is a
        touch-first surface. "Change source documents" additionally removed the NATIVE ring
        (`focus-visible:outline-none`) and named a ring COLOUR with no `focus-visible:ring-2` to
        draw — i.e. it had no visible focus indicator at all. The glyph and type scale are
        unchanged; only the tappable box grows.
      */}
      {!isGenerating && (
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onRegenerate}
            className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Regenerate
          </button>
          <button
            type="button"
            onClick={onChangeSourceDocuments}
            className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md px-1 text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
          >
            Change source documents
          </button>
        </div>
      )}
    </div>
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
  buttonRef,
  children,
}: Readonly<{
  onClick: () => void;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
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
