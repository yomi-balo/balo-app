'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { saveProposalDraftAction } from '@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { ResubmitProposalInput } from '@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal';
import { ChangeRequestNote, CHANGE_SECTION_NOUN, asChangeSection } from './change-request-note';
import { ComposerBriefCard } from './composer-brief-card';
import { jumpToField } from './composer-jump';
import { ComposerMobileBar } from './composer-mobile-bar';
import { ComposerPropertyBar } from './composer-property-bar';
import { ComposerSection } from './composer-section';
import { OverviewSection } from './overview-section';
import { MilestonesSection } from './milestones-section';
import { PricingSection } from './pricing-section';
import { AttachmentsSection } from './attachments-section';
import { useProposalDocumentUpload } from './proposal-document-uploader';
import { ProposalSummaryCard } from './proposal-summary-card';
import { ProposalPreview } from './proposal-preview';
import { ProposalSent } from './proposal-sent';
import { useSendProposal } from './use-send-proposal';
import { usePageFileDrop } from './use-page-file-drop';
import { draftToReviewDoc } from './proposal-draft-preview';
import type { ProposalExpertIdentity } from './proposal-review-types';
import {
  COMPOSER_TARGET,
  computeTotalCents,
  seedInstallments,
  summaryReadiness,
  toSavePayload,
  type ProposalCadenceValue,
  type ProposalDraftState,
  type ProposalInstallmentDraft,
  type ProposalMilestoneDraft,
  type ProposalPricingMethod,
  type ReadinessIssue,
} from './proposal-composer-state';

/**
 * The client's change request (A6.4 / BAL-290) — present ONLY in revise mode. Its
 * presence switches the composer to resubmit: autosave is disabled (local-only
 * edits until the atomic resubmit), the change note renders beside its section, and
 * Send becomes "Resend".
 */
interface ComposerChangeRequest {
  note: string;
  /** The DB `proposalChangeSectionEnum` value (`general` → the whole proposal). */
  section: string;
}

export interface ProposalComposerProps {
  requestId: string;
  relationshipId: string;
  clientFirstName: string;
  /** The client's full name, for attribution ("{clientName} @ {companyName}"). */
  clientName: string;
  /** The client company this proposal is for. */
  companyName: string;
  requestTitle: string;
  /** One-line plain-text summary of the request, shown on the collapsed brief card. */
  requestSummary: string;
  /** The full brief, rendered on the server through the sanitised rich-text path. */
  requestDescription: React.ReactNode;
  /** The page header (back link, title, version chip), shown only while editing. */
  header: React.ReactNode;
  /** The expert as the client sees them, for the preview document. */
  expert: ProposalExpertIdentity;
  /** Fully-hydrated initial snapshot from the server loader (never fetches here). */
  initialState: ProposalDraftState;
  /** Revise mode (A6.4 / BAL-290): the client's change request to address. */
  changeRequest?: ComposerChangeRequest;
  /** The current `changes_requested` proposal id (revise mode) — for the resubmit. */
  fromProposalId?: string;
  /** The current proposal version (revise mode) — the resubmit writes v{n+1}. */
  currentVersion?: number;
}

const AUTOSAVE_DEBOUNCE_MS = 800;

type ComposerMode = 'edit' | 'preview' | 'sent';
type JumpSource = 'rail' | 'cta' | 'mobile_bar' | 'shortcut';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_LABEL = {
  saving: 'Saving…',
  saved: 'Saved as draft',
  error: "Couldn't save draft",
} as const;

const REVISE_NOTE = 'Not saved until you resend';

/** The outcome of one save round: whether it landed and the draft id it resolved to. */
interface SaveOutcome {
  ok: boolean;
  proposalId: string | null;
}

const METHOD_TOAST_ID = 'proposal-method-switch';
const MILESTONE_PRICING_TOAST_ID = 'proposal-milestone-pricing';
const milestoneRemovedToastId = (key: string): string => `proposal-milestone-removed-${key}`;

const METHOD_SWITCH_TOAST: Record<ProposalPricingMethod, string> = {
  tm: 'Switched to time and materials. Your fixed amounts come back if you switch again.',
  fixed: 'Switched to fixed price. Your hour estimates come back if you switch again.',
};

function toastWithUndo(message: string, onUndo: () => void, id: string): void {
  toast(message, { id, action: { label: 'Undo', onClick: onUndo } });
}

function milestoneHasContent(milestone: ProposalMilestoneDraft): boolean {
  return (
    milestone.title.trim().length > 0 ||
    milestone.descriptionHtml.trim().length > 0 ||
    (milestone.valueCents ?? 0) > 0
  );
}

interface NotedSectionProps {
  /** The change note pinned above the section, when this section is the one it is about. */
  note: React.ReactNode;
  children: React.ReactNode;
}

/** A section with its change note above it; without a note it renders the section untouched. */
function NotedSection({ note, children }: Readonly<NotedSectionProps>): React.JSX.Element {
  if (note === null) return <>{children}</>;
  return (
    <div className="pt-11 [&>section]:pt-0">
      {note}
      {children}
    </div>
  );
}

/**
 * The expert proposal composer (A6.2 / BAL-288, reshaped by BAL-610). One page in a
 * fixed order — property bar, brief, overview, milestones, pricing, exclusions,
 * attachments — beside a jump-to checklist rail. It owns the single
 * `ProposalDraftState`, a debounced best-effort autosave (race-guarded via a
 * monotonic `saveSeq`; no concurrent saves — coalesces a dirty-during-save into one
 * trailing save), and a `mode` machine: `edit` → `preview` → `sent`. A successful
 * send routes to `?sent=` so the page serves the confirmation; the local `sent` mode is
 * the fallback while that navigation lands. The edit tree stays mounted (hidden) during
 * `preview`, so expanded rows and the scroll position survive "Back to editing".
 */
export function ProposalComposer({
  requestId,
  relationshipId,
  clientFirstName,
  clientName,
  companyName,
  requestTitle,
  requestSummary,
  requestDescription,
  header,
  expert,
  initialState,
  changeRequest,
  fromProposalId,
  currentVersion,
}: Readonly<ProposalComposerProps>): React.JSX.Element {
  const [state, setState] = useState<ProposalDraftState>(initialState);
  const [mode, setMode] = useState<ComposerMode>('edit');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [nudgeKey, setNudgeKey] = useState(0);
  const [addressed, setAddressed] = useState(false);
  const [sentVersion, setSentVersion] = useState(1);
  const editScrollYRef = useRef(0);
  const removedToastIdsRef = useRef(new Set<string>());

  // Revise mode (A6.4 / BAL-290): a change request switches the composer to a
  // local-only resubmit — autosave is disabled and Send calls `resubmitProposalAction`.
  const reviseMode = changeRequest !== undefined;
  const nextVersion = (currentVersion ?? 1) + 1;

  // Autosave coordination refs (no re-render churn).
  const stateRef = useRef(state);
  stateRef.current = state;
  const proposalIdRef = useRef<string | null>(initialState.proposalId);
  const saveSeqRef = useRef(0);
  const savePromiseRef = useRef<Promise<SaveOutcome> | null>(null);
  const savedKeyRef = useRef<string | null>(null);
  const dirtyDuringSaveRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the autosave the very first render fires (hydrated state isn't dirty).
  const hydratedRef = useRef(false);

  const totalCents = useMemo(() => computeTotalCents(state), [state]);
  const readiness = useMemo(() => summaryReadiness(state), [state]);

  const termsDocuments = useMemo(
    () => state.documents.filter((d) => d.kind === 'terms'),
    [state.documents]
  );
  const refDocuments = useMemo(
    () => state.documents.filter((d) => d.kind === 'ref'),
    [state.documents]
  );

  /** One save round against the LATEST state; never throws. */
  const saveOnce = useCallback(async (): Promise<SaveOutcome> => {
    saveSeqRef.current += 1;
    const seq = saveSeqRef.current;
    setSaveStatus('saving');
    try {
      const payload = toSavePayload(stateRef.current, requestId, relationshipId);
      const key = JSON.stringify(payload);
      const result = await saveProposalDraftAction(payload);
      if (!result.success) {
        if (seq === saveSeqRef.current) setSaveStatus('error');
        return { ok: false, proposalId: proposalIdRef.current };
      }
      proposalIdRef.current = result.proposalId;
      savedKeyRef.current = key;
      if (seq === saveSeqRef.current) {
        if (stateRef.current.proposalId === null) {
          setState((prev) => ({ ...prev, proposalId: result.proposalId }));
        }
        setSaveStatus('saved');
      }
      return { ok: true, proposalId: result.proposalId };
    } catch {
      if (seq === saveSeqRef.current) setSaveStatus('error');
      return { ok: false, proposalId: proposalIdRef.current };
    }
  }, [requestId, relationshipId]);

  /**
   * Run an autosave against the LATEST state. Only one save is in flight: a caller that
   * arrives mid-save gets that save's promise, and flags it to run one trailing round
   * so the newest state lands before the promise settles.
   */
  const runSave = useCallback((): Promise<SaveOutcome> => {
    const pending = savePromiseRef.current;
    if (pending !== null) {
      dirtyDuringSaveRef.current = true;
      return pending;
    }
    const run = (async (): Promise<SaveOutcome> => {
      let outcome: SaveOutcome;
      do {
        dirtyDuringSaveRef.current = false;
        outcome = await saveOnce();
      } while (dirtyDuringSaveRef.current);
      return outcome;
    })().finally(() => {
      savePromiseRef.current = null;
    });
    savePromiseRef.current = run;
    return run;
  }, [saveOnce]);

  // Debounced autosave on every state change (skips the initial hydration render).
  // DISABLED entirely in revise mode (A6.4): revise edits are local-only until the
  // atomic resubmit — the partial-unique `is_current` index forbids a parallel v2
  // draft, so we never write a draft here while a `changes_requested` proposal exists.
  useEffect(() => {
    if (reviseMode) return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSave();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
    // Re-run whenever any persisted slice changes (documents persist out-of-band).
  }, [
    reviseMode,
    state.overview,
    state.pricingMethod,
    state.currency,
    state.timeframeWeeks,
    state.exclusions,
    state.depositCents,
    state.rateCents,
    state.fixedPriceCents,
    state.cadence,
    state.milestones,
    state.installments,
    state.milestonePricingEnabled,
    runSave,
  ]);

  /**
   * Force a persisted draft to exist (documents require a proposalId). If the
   * first autosave hasn't created one yet, flush a save and await its id.
   */
  const ensureProposalId = useCallback(async (): Promise<string | null> => {
    if (proposalIdRef.current !== null) return proposalIdRef.current;
    return (await runSave()).proposalId;
  }, [runSave]);

  /**
   * Flush a final save before submit (Q2) and return the id the server will submit, or
   * null when the save failed so the send aborts. A save already in flight is awaited
   * first; another runs only if the draft changed since that one began.
   */
  const flushBeforeSubmit = useCallback(async (): Promise<string | null> => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    const pending = savePromiseRef.current;
    if (pending !== null) {
      const settled = await pending;
      if (!settled.ok) return null;
      const latestKey = JSON.stringify(toSavePayload(stateRef.current, requestId, relationshipId));
      if (latestKey === savedKeyRef.current) return settled.proposalId;
    }
    const outcome = await runSave();
    return outcome.ok ? outcome.proposalId : null;
  }, [runSave, requestId, relationshipId]);

  const handleRetrySave = useCallback((): void => {
    flushBeforeSubmit();
  }, [flushBeforeSubmit]);

  // ── Slice setters threaded to the sections (no per-section form state) ──
  const setOverview = useCallback((overview: string): void => {
    setState((prev) => ({ ...prev, overview }));
  }, []);

  /**
   * Fire `PROPOSAL_PRICING_METHOD_SWITCHED` for a method change. Uses the proposalId
   * ref (may be null on a never-saved draft → empty string for the typed property).
   * `had_typed_price` reflects whether a typed Fixed price existed at switch time.
   */
  const trackMethodSwitch = useCallback(
    (from: ProposalPricingMethod, to: ProposalPricingMethod, hadTypedPrice: boolean): void => {
      track(PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED, {
        proposal_id: proposalIdRef.current ?? '',
        from_method: from,
        to_method: to,
        had_typed_price: hadTypedPrice,
      });
    },
    []
  );

  /**
   * Switch the pricing method immediately, then offer Undo (BAL-610; the BAL-294
   * confirm dialog is gone). The typed `fixedPriceCents`, per-milestone values and
   * hour estimates are all kept in state, so a switch back restores them. T&M → Fixed
   * pre-fills a blank price with the last derived T&M total (only when above 0) and
   * seeds the payment schedule when it is empty. Undo is a no-op unless the method is
   * still the one the switch chose, and reverts only the fields still holding what the
   * switch set, so later edits survive it.
   */
  const setPricingMethod = useCallback(
    (next: ProposalPricingMethod): void => {
      const prev = stateRef.current;
      const from = prev.pricingMethod;
      if (next === from) return;

      const before = { fixedPriceCents: prev.fixedPriceCents, installments: prev.installments };
      const derivedTotal = computeTotalCents(prev);
      const hadTypedPrice =
        from === 'fixed' && prev.fixedPriceCents !== null && prev.fixedPriceCents !== 0;
      const applied =
        next === 'tm'
          ? before
          : {
              fixedPriceCents: prev.fixedPriceCents ?? (derivedTotal > 0 ? derivedTotal : null),
              installments: prev.installments.length === 0 ? seedInstallments() : prev.installments,
            };

      setState((current) => ({ ...current, pricingMethod: next, ...applied }));
      trackMethodSwitch(from, next, hadTypedPrice);
      toastWithUndo(
        METHOD_SWITCH_TOAST[next],
        () => {
          if (stateRef.current.pricingMethod !== next) return;
          setState((current) => ({
            ...current,
            pricingMethod: from,
            fixedPriceCents:
              current.fixedPriceCents === applied.fixedPriceCents
                ? before.fixedPriceCents
                : current.fixedPriceCents,
            installments:
              current.installments === applied.installments
                ? before.installments
                : current.installments,
          }));
          trackMethodSwitch(next, from, hadTypedPrice);
        },
        METHOD_TOAST_ID
      );
    },
    [trackMethodSwitch]
  );

  const setFixedPrice = useCallback((fixedPriceCents: number | null): void => {
    setState((prev) => ({ ...prev, fixedPriceCents }));
  }, []);

  const setTimeframe = useCallback((timeframeWeeks: number | null): void => {
    setState((prev) => ({ ...prev, timeframeWeeks }));
  }, []);

  const handleExclusionsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const exclusions = event.target.value;
      setState((prev) => ({ ...prev, exclusions }));
    },
    []
  );

  /**
   * Removing one milestone that holds content offers Undo, which puts it back at its
   * index (skipped if it is already back).
   */
  const offerMilestoneRestore = useCallback(
    (removed: ProposalMilestoneDraft, index: number): void => {
      const toastId = milestoneRemovedToastId(removed.key);
      removedToastIdsRef.current.add(toastId);
      toastWithUndo(
        'Milestone removed.',
        () => {
          setState((prev) => {
            if (prev.milestones.some((m) => m.key === removed.key)) return prev;
            const at = Math.min(index, prev.milestones.length);
            return {
              ...prev,
              milestones: [...prev.milestones.slice(0, at), removed, ...prev.milestones.slice(at)],
            };
          });
        },
        toastId
      );
    },
    []
  );

  const setMilestones = useCallback(
    (milestones: ProposalMilestoneDraft[]): void => {
      const previous = stateRef.current.milestones;
      setState((prev) => ({ ...prev, milestones }));
      if (milestones.length !== previous.length - 1) return;
      const keep = new Set(milestones.map((m) => m.key));
      const index = previous.findIndex((m) => !keep.has(m.key));
      const removed = previous[index];
      if (removed !== undefined && milestoneHasContent(removed)) {
        offerMilestoneRestore(removed, index);
      }
    },
    [offerMilestoneRestore]
  );

  const trackMilestonePricingToggled = useCallback((enabled: boolean): void => {
    track(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED, {
      proposal_id: proposalIdRef.current ?? '',
      enabled,
      milestone_count: stateRef.current.milestones.length,
    });
  }, []);

  /**
   * The "Price each milestone" switch. Turning it OFF nulls every amount (the project
   * price stays) and, when any amount was set, offers Undo to restore the amounts by
   * milestone key (rows added since keep their own amount) and the switch.
   */
  const toggleMilestonePricing = useCallback(
    (enabled: boolean): void => {
      trackMilestonePricingToggled(enabled);
      if (enabled) {
        toast.dismiss(MILESTONE_PRICING_TOAST_ID);
        setState((prev) => ({ ...prev, milestonePricingEnabled: true }));
        return;
      }

      const amountsByKey = new Map(
        stateRef.current.milestones.map((m) => [m.key, m.valueCents] as const)
      );
      const hadAmounts = [...amountsByKey.values()].some((value) => (value ?? 0) > 0);
      setState((prev) => ({
        ...prev,
        milestonePricingEnabled: false,
        milestones: prev.milestones.map((m) => ({ ...m, valueCents: null })),
      }));
      if (!hadAmounts) return;
      toastWithUndo(
        'Milestone amounts removed. Your project price stays the same.',
        () => {
          setState((prev) => ({
            ...prev,
            milestonePricingEnabled: true,
            milestones: prev.milestones.map((m) => ({
              ...m,
              valueCents: amountsByKey.get(m.key) ?? m.valueCents,
            })),
          }));
          trackMilestonePricingToggled(true);
        },
        MILESTONE_PRICING_TOAST_ID
      );
    },
    [trackMilestonePricingToggled]
  );

  const setInstallments = useCallback((installments: ProposalInstallmentDraft[]): void => {
    setState((prev) => ({ ...prev, installments }));
  }, []);

  const setDeposit = useCallback((depositCents: number | null): void => {
    setState((prev) => ({ ...prev, depositCents }));
  }, []);

  const setRate = useCallback((rateCents: number | null): void => {
    setState((prev) => ({ ...prev, rateCents }));
  }, []);

  const setCadence = useCallback((cadence: ProposalCadenceValue): void => {
    setState((prev) => ({ ...prev, cadence }));
  }, []);

  const addDocument = useCallback((document: ProposalDocumentView): void => {
    setState((prev) => ({
      ...prev,
      // Replace any same-kind 'terms' doc (single supplement); append for 'ref'.
      documents:
        document.kind === 'terms'
          ? [...prev.documents.filter((d) => d.kind !== 'terms'), document]
          : [...prev.documents, document],
    }));
  }, []);

  const removeDocument = useCallback((documentId: string): void => {
    setState((prev) => ({
      ...prev,
      documents: prev.documents.filter((d) => d.id !== documentId),
    }));
  }, []);

  // One upload pipeline per document kind, shared by the page-wide drop, the
  // Attachments section and the Terms popover.
  const refUpload = useProposalDocumentUpload({
    requestId,
    relationshipId,
    kind: 'ref',
    documents: refDocuments,
    ensureProposalId,
    onAdded: addDocument,
    onRemoved: removeDocument,
  });
  const termsUpload = useProposalDocumentUpload({
    requestId,
    relationshipId,
    kind: 'terms',
    single: true,
    documents: termsDocuments,
    ensureProposalId,
    onAdded: addDocument,
    onRemoved: removeDocument,
  });
  const { dragActive } = usePageFileDrop({
    enabled: mode === 'edit',
    onFiles: refUpload.uploadFiles,
  });

  // ── Jump + preview ──
  const softIssues = useMemo<ReadinessIssue[]>(() => {
    if (changeRequest === undefined || addressed) return [];
    const noun = CHANGE_SECTION_NOUN[asChangeSection(changeRequest.section)];
    return [
      {
        id: 'change_request',
        label: `${clientFirstName}'s note on ${noun} isn't marked as addressed`,
        targetId: COMPOSER_TARGET.changeNote,
      },
    ];
  }, [changeRequest, addressed, clientFirstName]);

  const handleJump = useCallback((issue: ReadinessIssue, source: JumpSource): void => {
    jumpToField(issue.targetId);
    track(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED, {
      proposal_id: proposalIdRef.current ?? '',
      issue_id: issue.id,
      source,
    });
  }, []);

  /**
   * "Preview and send": with readiness issues left, jump to the first and replay the
   * checklist nudge; otherwise open the full-page preview. Reads the latest state from
   * the ref so the keyboard shortcut and both CTAs share one stable callback.
   */
  const goPreview = useCallback(
    (source: JumpSource): void => {
      const latest = stateRef.current;
      const [firstIssue] = summaryReadiness(latest).issues;
      if (firstIssue !== undefined) {
        handleJump(firstIssue, source);
        setNudgeKey((key) => key + 1);
        return;
      }
      track(PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED, {
        proposal_id: proposalIdRef.current ?? '',
        pricing_method: latest.pricingMethod,
        is_resubmit: reviseMode,
        milestone_count: latest.milestones.length,
        milestones_priced: latest.pricingMethod === 'fixed' && latest.milestonePricingEnabled,
      });
      editScrollYRef.current = globalThis.scrollY;
      setMode('preview');
    },
    [handleJump, reviseMode]
  );

  const handleRailJump = useCallback(
    (issue: ReadinessIssue): void => handleJump(issue, 'rail'),
    [handleJump]
  );
  const handleRailPreview = useCallback((): void => goPreview('cta'), [goPreview]);
  const handleMobilePreview = useCallback((): void => goPreview('mobile_bar'), [goPreview]);
  const handleMobileJumpFirst = useCallback((): void => {
    const [firstIssue] = summaryReadiness(stateRef.current).issues;
    if (firstIssue !== undefined) handleJump(firstIssue, 'mobile_bar');
  }, [handleJump]);
  const handleBackToEdit = useCallback((): void => setMode('edit'), []);
  const handleGoToNote = useCallback((): void => {
    jumpToField(COMPOSER_TARGET.changeNote);
  }, []);
  const toggleAddressed = useCallback((): void => setAddressed((current) => !current), []);

  // ⌘/Ctrl+Enter previews (edit mode only; never mid-IME composition). Registered in
  // the capture phase and stopped there so an editor never sees the key and inserts a
  // hard break.
  useEffect(() => {
    if (mode !== 'edit') return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      goPreview('shortcut');
    };
    globalThis.addEventListener('keydown', handleKeyDown, true);
    return () => globalThis.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, goPreview]);

  // Each mode is its own screen: start it at the top, except coming back to the edit
  // tree, which returns to where the expert left it.
  const previousModeRef = useRef(mode);
  useEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    globalThis.scrollTo(0, mode === 'edit' ? editScrollYRef.current : 0);
  }, [mode]);

  // An Undo toast edits the draft, so none outlives the edit screen.
  const dismissUndoToasts = useCallback((): void => {
    toast.dismiss(METHOD_TOAST_ID);
    toast.dismiss(MILESTONE_PRICING_TOAST_ID);
    for (const id of removedToastIdsRef.current) toast.dismiss(id);
    removedToastIdsRef.current.clear();
  }, []);
  useEffect(() => {
    if (mode !== 'edit') dismissUndoToasts();
  }, [mode, dismissUndoToasts]);
  useEffect(() => dismissUndoToasts, [dismissUndoToasts]);

  // Revise mode: build the FULL resubmit payload from the latest state at send time
  // (same body as the autosave/submit, extended with `fromProposalId`).
  const buildResubmitPayload = useCallback((): ResubmitProposalInput => {
    return {
      ...toSavePayload(stateRef.current, requestId, relationshipId),
      fromProposalId: fromProposalId ?? '',
    };
  }, [requestId, relationshipId, fromProposalId]);

  const handleSent = useCallback((version: number): void => {
    setSentVersion(version);
    setMode('sent');
  }, []);

  const { send, pending } = useSendProposal({
    requestId,
    relationshipId,
    companyName,
    onBeforeSubmit: flushBeforeSubmit,
    resubmit: reviseMode ? { nextVersion, getPayload: buildResubmitPayload } : undefined,
    onSent: handleSent,
  });

  const previewDoc = useMemo(
    () =>
      mode === 'preview'
        ? draftToReviewDoc(state, {
            requestId,
            relationshipId,
            version: reviseMode ? nextVersion : 1,
            expert,
          })
        : null,
    [mode, state, requestId, relationshipId, reviseMode, nextVersion, expert]
  );

  // ── Render ──
  // Only the two outcomes worth interrupting for are live: a failed save (assertive,
  // with a next step) and a save that landed (polite, once per transition). "Saving…"
  // and the revise note are plain text.
  const statusNode = reviseMode ? (
    <span className="text-muted-foreground text-[13px]">{REVISE_NOTE}</span>
  ) : (
    <span className="text-[13px]">
      {saveStatus === 'saving' && (
        <span className="text-muted-foreground">{SAVE_LABEL.saving}</span>
      )}
      <span role="status" className="text-muted-foreground">
        {saveStatus === 'saved' ? SAVE_LABEL.saved : null}
      </span>
      <span role="alert" className="text-destructive">
        {saveStatus === 'error' ? SAVE_LABEL.error : null}
      </span>
      {saveStatus === 'error' && (
        <button
          type="button"
          onClick={handleRetrySave}
          className="text-primary focus-visible:ring-ring -my-2 ml-1 inline-flex min-h-11 items-center rounded px-2 font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Retry
        </button>
      )}
    </span>
  );

  const noteSection = changeRequest ? asChangeSection(changeRequest.section) : null;
  const changeNote = changeRequest ? (
    <ChangeRequestNote
      section={changeRequest.section}
      clientName={clientName}
      company={noteSection === 'timeline' ? companyName : undefined}
      note={changeRequest.note}
      addressed={addressed}
      onToggle={toggleAddressed}
    />
  ) : null;
  const noteFor = (...sections: string[]): React.ReactNode =>
    noteSection !== null && sections.includes(noteSection) ? changeNote : null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none">
      {mode !== 'sent' && (
        <div hidden={mode !== 'edit'}>
          {header}
          <div className="grid grid-cols-1 items-start gap-y-8 pb-28 lg:grid-cols-[minmax(0,1fr)_18.75rem] lg:gap-x-14 lg:pb-0">
            <div className="min-w-0">
              <ComposerPropertyBar
                pricingMethod={state.pricingMethod}
                onPricingMethodChange={setPricingMethod}
                timeframeWeeks={state.timeframeWeeks}
                onTimeframeChange={setTimeframe}
                termsDocuments={termsDocuments}
                termsUpload={termsUpload}
                trailing={mode === 'edit' ? statusNode : null}
              />

              {noteFor('timeline')}

              {reviseMode && (
                <div className="bg-info/10 mb-5 flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-sm">
                  <span className="text-foreground/80 flex items-center gap-2">
                    <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
                    {noteSection === 'timeline'
                      ? clientName
                      : `${clientName} @ ${companyName}`}{' '}
                    asked for one change.
                  </span>
                  <button
                    type="button"
                    onClick={handleGoToNote}
                    className="text-primary focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded text-[13.5px] font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Go to note
                  </button>
                </div>
              )}

              <ComposerBriefCard
                clientFirstName={clientFirstName}
                summary={requestSummary}
                body={requestDescription}
              />

              <NotedSection note={noteFor('general')}>
                <OverviewSection
                  overview={state.overview}
                  onOverviewChange={setOverview}
                  companyName={companyName}
                />
              </NotedSection>

              <NotedSection note={noteFor('milestones')}>
                <MilestonesSection
                  milestones={state.milestones}
                  pricingMethod={state.pricingMethod}
                  milestonePricingEnabled={state.milestonePricingEnabled}
                  fixedPriceCents={state.fixedPriceCents}
                  totalCents={totalCents}
                  currency={state.currency}
                  onChange={setMilestones}
                  onToggleMilestonePricing={toggleMilestonePricing}
                  onSetPrice={setFixedPrice}
                />
              </NotedSection>

              <NotedSection note={noteFor('pricing', 'payment_terms')}>
                <PricingSection
                  state={state}
                  totalCents={totalCents}
                  companyName={companyName}
                  onFixedPriceChange={setFixedPrice}
                  onInstallmentsChange={setInstallments}
                  onDepositChange={setDeposit}
                  onRateChange={setRate}
                  onCadenceChange={setCadence}
                />
              </NotedSection>

              <ComposerSection
                id="proposal-section-exclusions"
                title="Not included"
                optional
                help="Anything explicitly out of scope, so there are no surprises later."
              >
                <Textarea
                  id="proposal-exclusions"
                  aria-label="What's not included"
                  value={state.exclusions}
                  onChange={handleExclusionsChange}
                  rows={3}
                  placeholder="Migrating historical quotes from your spreadsheets"
                />
              </ComposerSection>

              <AttachmentsSection documents={refDocuments} upload={refUpload} />
            </div>

            <aside aria-label="Proposal summary" className="hidden lg:sticky lg:top-6 lg:block">
              <ProposalSummaryCard
                state={state}
                totalCents={totalCents}
                readiness={readiness}
                softIssues={softIssues}
                termsAttached={termsDocuments.length > 0}
                reviseMode={reviseMode}
                nudgeKey={nudgeKey}
                onJump={handleRailJump}
                onPreview={handleRailPreview}
              />
            </aside>
          </div>

          <ComposerMobileBar
            state={state}
            totalCents={totalCents}
            readiness={readiness}
            reviseMode={reviseMode}
            onJumpFirst={handleMobileJumpFirst}
            onPreview={handleMobilePreview}
          />
        </div>
      )}

      {mode === 'preview' && previewDoc !== null && (
        <div className="mx-auto max-w-3xl">
          {reviseMode && (
            <p className="text-muted-foreground mb-3 text-right text-[13px]">{REVISE_NOTE}</p>
          )}
          <ProposalPreview
            doc={previewDoc}
            requestTitle={requestTitle}
            companyName={companyName}
            reviseMode={reviseMode}
            pending={pending}
            onBack={handleBackToEdit}
            onSend={send}
          />
        </div>
      )}

      {mode === 'sent' && (
        <div className="mx-auto max-w-3xl">
          <ProposalSent
            requestId={requestId}
            companyName={companyName}
            clientName={clientName}
            reviseMode={reviseMode}
            version={sentVersion}
          />
        </div>
      )}

      {dragActive && (
        <div
          role="status"
          className="bg-background/85 pointer-events-none fixed inset-0 z-[60] grid place-items-center"
        >
          <div className="border-primary bg-card text-primary flex items-center gap-2.5 rounded-2xl border-2 border-dashed px-6 py-4 font-medium">
            <Paperclip className="size-[18px]" aria-hidden="true" />
            Drop to attach to your proposal
          </div>
        </div>
      )}
    </div>
  );
}
