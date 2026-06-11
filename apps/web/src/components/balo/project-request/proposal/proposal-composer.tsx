'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { saveProposalDraftAction } from '@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import { ComposerTabStrip, type ComposerTabId } from './composer-tab-strip';
import { OverviewTab } from './overview-tab';
import { MilestonesTab } from './milestones-tab';
import { PaymentTermsTab } from './payment-terms-tab';
import { AttachmentsTab } from './attachments-tab';
import { ProposalSummaryCard, type SaveStatus } from './proposal-summary-card';
import { SubmitProposalDialog } from './submit-proposal-dialog';
import {
  computeTotalCents,
  installmentsSum,
  nextDraftKey,
  seedInstallments,
  summaryReadiness,
  toSavePayload,
  type ProposalCadenceValue,
  type ProposalDraftState,
  type ProposalInstallmentDraft,
  type ProposalMilestoneDraft,
  type ProposalPricingMethod,
} from './proposal-composer-state';

interface ProposalComposerProps {
  requestId: string;
  relationshipId: string;
  clientFirstName: string;
  /** Fully-hydrated initial snapshot from the server loader (never fetches here). */
  initialState: ProposalDraftState;
}

const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * The expert proposal composer (A6.2 / BAL-288). Owns the single
 * `ProposalDraftState`, a debounced best-effort autosave (race-guarded via a
 * monotonic `saveSeq`; no concurrent saves — coalesces a dirty-during-save into
 * one trailing save), tab selection, the mobile summary sheet, and the submit
 * dialog. The 4 tabs receive slice setters — no per-tab local form state, so the
 * summary card and cross-tab dependencies stay coherent.
 */
export function ProposalComposer({
  requestId,
  relationshipId,
  clientFirstName,
  initialState,
}: Readonly<ProposalComposerProps>): React.JSX.Element {
  const [state, setState] = useState<ProposalDraftState>(initialState);
  const [activeTab, setActiveTab] = useState<ComposerTabId>('overview');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  // Autosave coordination refs (no re-render churn).
  const stateRef = useRef(state);
  stateRef.current = state;
  const proposalIdRef = useRef<string | null>(initialState.proposalId);
  const saveSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const dirtyDuringSaveRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the autosave the very first render fires (hydrated state isn't dirty).
  const hydratedRef = useRef(false);

  const totalCents = useMemo(() => computeTotalCents(state), [state]);
  const installmentSum = useMemo(() => installmentsSum(state), [state]);
  const readiness = useMemo(() => summaryReadiness(state), [state]);

  const termsDocuments = useMemo(
    () => state.documents.filter((d) => d.kind === 'terms'),
    [state.documents]
  );
  const refDocuments = useMemo(
    () => state.documents.filter((d) => d.kind === 'ref'),
    [state.documents]
  );

  /**
   * Run one autosave against the LATEST state. Race-guarded: a stale response
   * (seq < latest) never clobbers a newer proposalId. Coalesces concurrent
   * requests — only one save in flight; a dirty-during-save fires one trailing.
   */
  const runSave = useCallback(async (): Promise<string | null> => {
    if (inFlightRef.current) {
      dirtyDuringSaveRef.current = true;
      return proposalIdRef.current;
    }
    inFlightRef.current = true;
    saveSeqRef.current += 1;
    const seq = saveSeqRef.current;
    setSaveStatus('saving');

    let resolvedId = proposalIdRef.current;
    try {
      const payload = toSavePayload(stateRef.current, requestId, relationshipId);
      const result = await saveProposalDraftAction(payload);
      if (seq === saveSeqRef.current) {
        if (result.success) {
          resolvedId = result.proposalId;
          proposalIdRef.current = result.proposalId;
          if (stateRef.current.proposalId === null) {
            setState((prev) => ({ ...prev, proposalId: result.proposalId }));
          }
          setSaveStatus('saved');
        } else {
          setSaveStatus('error');
        }
      }
    } catch {
      if (seq === saveSeqRef.current) setSaveStatus('error');
    } finally {
      inFlightRef.current = false;
    }

    if (dirtyDuringSaveRef.current) {
      dirtyDuringSaveRef.current = false;
      return runSave();
    }
    return resolvedId;
  }, [requestId, relationshipId]);

  // Debounced autosave on every state change (skips the initial hydration render).
  useEffect(() => {
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
    state.overview,
    state.pricingMethod,
    state.currency,
    state.timeframeWeeks,
    state.exclusions,
    state.depositCents,
    state.rateCents,
    state.cadence,
    state.milestones,
    state.installments,
    runSave,
  ]);

  /**
   * Force a persisted draft to exist (documents require a proposalId). If the
   * first autosave hasn't created one yet, flush a save and await its id.
   */
  const ensureProposalId = useCallback(async (): Promise<string | null> => {
    if (proposalIdRef.current !== null) return proposalIdRef.current;
    return runSave();
  }, [runSave]);

  // Flush a final save before submit (Q2) — returns the id the server will submit.
  const flushBeforeSubmit = useCallback(async (): Promise<string | null> => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    return runSave();
  }, [runSave]);

  // ── Slice setters threaded to the tabs (no per-tab form state) ──
  const setOverview = useCallback((overview: string): void => {
    setState((prev) => ({ ...prev, overview }));
  }, []);

  const setPricingMethod = useCallback((pricingMethod: ProposalPricingMethod): void => {
    setState((prev) => ({ ...prev, pricingMethod }));
  }, []);

  const setTimeframe = useCallback((timeframeWeeks: number | null): void => {
    setState((prev) => ({ ...prev, timeframeWeeks }));
  }, []);

  const setExclusions = useCallback((exclusions: string): void => {
    setState((prev) => ({ ...prev, exclusions }));
  }, []);

  const setMilestones = useCallback((milestones: ProposalMilestoneDraft[]): void => {
    setState((prev) => ({ ...prev, milestones }));
  }, []);

  const addMilestone = useCallback((): void => {
    setState((prev) => ({
      ...prev,
      milestones: [
        ...prev.milestones,
        {
          key: nextDraftKey(),
          title: '',
          descriptionHtml: '',
          acceptanceCriteria: '',
          valueCents: prev.pricingMethod === 'fixed' ? 0 : null,
        },
      ],
    }));
  }, []);

  const setInstallments = useCallback((installments: ProposalInstallmentDraft[]): void => {
    setState((prev) => ({ ...prev, installments }));
  }, []);

  const addInstallment = useCallback((): void => {
    setState((prev) => ({
      ...prev,
      installments: [...prev.installments, { key: nextDraftKey(), label: '', pct: 0 }],
    }));
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

  const openSubmit = useCallback((): void => {
    setSheetOpen(false);
    setSubmitOpen(true);
  }, []);

  // If a fresh draft ever loses its seed (shouldn't happen), keep one installment.
  const ensuredInstallments =
    state.installments.length === 0 ? seedInstallments() : state.installments;

  const tabIssues: Partial<Record<ComposerTabId, boolean>> = useMemo(() => {
    const overviewIssue = readiness.issues.includes('Add an overview');
    const milestoneIssue =
      readiness.issues.includes('Add at least one milestone') ||
      readiness.issues.includes('A milestone is missing a title') ||
      readiness.issues.includes('A milestone is missing a value');
    const paymentIssue = readiness.issues.some(
      (i) => i.startsWith('Payment terms') || i === 'Add a deposit' || i === 'Add an hourly rate'
    );
    return {
      overview: overviewIssue,
      milestones: milestoneIssue,
      payment: paymentIssue,
    };
  }, [readiness.issues]);

  const summaryCard = (
    <ProposalSummaryCard
      state={state}
      totalCents={totalCents}
      readiness={readiness}
      clientFirstName={clientFirstName}
      termsDocumentCount={termsDocuments.length}
      saveStatus={saveStatus}
      submitting={submitOpen}
      onSubmit={openSubmit}
    />
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-1 items-start gap-5 duration-500 motion-reduce:animate-none lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <ComposerTabStrip active={activeTab} onChange={setActiveTab} issues={tabIssues} />

        <div
          key={activeTab}
          role="tabpanel"
          id={`composer-panel-${activeTab}`}
          aria-labelledby={`composer-tab-${activeTab}`}
          className="border-border bg-card animate-in fade-in fill-mode-both rounded-2xl border p-5 duration-300 motion-reduce:animate-none sm:p-6"
        >
          {activeTab === 'overview' && (
            <OverviewTab
              overview={state.overview}
              onOverviewChange={setOverview}
              pricingMethod={state.pricingMethod}
              onPricingMethodChange={setPricingMethod}
              timeframeWeeks={state.timeframeWeeks}
              onTimeframeChange={setTimeframe}
              exclusions={state.exclusions}
              onExclusionsChange={setExclusions}
            />
          )}
          {activeTab === 'milestones' && (
            <MilestonesTab
              milestones={state.milestones}
              pricingMethod={state.pricingMethod}
              onChange={setMilestones}
              onAdd={addMilestone}
            />
          )}
          {activeTab === 'payment' && (
            <PaymentTermsTab
              pricingMethod={state.pricingMethod}
              totalCents={totalCents}
              currency={state.currency}
              installments={ensuredInstallments}
              installmentSum={installmentSum}
              onInstallmentsChange={setInstallments}
              onAddInstallment={addInstallment}
              depositCents={state.depositCents}
              onDepositChange={setDeposit}
              rateCents={state.rateCents}
              onRateChange={setRate}
              cadence={state.cadence}
              onCadenceChange={setCadence}
              requestId={requestId}
              relationshipId={relationshipId}
              termsDocuments={termsDocuments}
              ensureProposalId={ensureProposalId}
              onDocumentAdded={addDocument}
              onDocumentRemoved={removeDocument}
            />
          )}
          {activeTab === 'attachments' && (
            <AttachmentsTab
              requestId={requestId}
              relationshipId={relationshipId}
              documents={refDocuments}
              ensureProposalId={ensureProposalId}
              onAdded={addDocument}
              onRemoved={removeDocument}
            />
          )}
        </div>

        {/* Mobile: collapsed summary bar → bottom sheet. */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className={cn(
            'border-border bg-card focus-visible:ring-ring flex w-full items-center justify-between rounded-2xl border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none lg:hidden',
            readiness.ready ? 'border-success/40' : 'border-warning/40'
          )}
        >
          <span className="min-w-0">
            <span className="text-foreground block text-sm font-semibold">
              {state.pricingMethod === 'fixed'
                ? formatWholeCurrency(totalCents, state.currency)
                : `~${formatWholeCurrency(totalCents, state.currency)}`}
              {' · '}
              {state.milestones.length} milestone{state.milestones.length === 1 ? '' : 's'}
              {state.timeframeWeeks !== null && ` · ~${state.timeframeWeeks} wks`}
            </span>
            <span
              className={cn(
                'block text-[12px] font-medium',
                readiness.ready ? 'text-success' : 'text-warning'
              )}
            >
              {readiness.ready ? 'Ready to submit' : `${readiness.issues.length} to finish`}
            </span>
          </span>
          <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden="true" />
        </button>
      </div>

      {/* Desktop: sticky summary card. */}
      <div className="hidden lg:sticky lg:top-6 lg:block">{summaryCard}</div>

      {/* Mobile summary sheet. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="max-h-[88vh] gap-0 overflow-y-auto rounded-t-2xl lg:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Proposal summary</SheetTitle>
          </SheetHeader>
          <div className="p-4">{summaryCard}</div>
        </SheetContent>
      </Sheet>

      <SubmitProposalDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        requestId={requestId}
        relationshipId={relationshipId}
        proposalId={state.proposalId}
        clientFirstName={clientFirstName}
        onBeforeSubmit={flushBeforeSubmit}
      />
    </div>
  );
}
