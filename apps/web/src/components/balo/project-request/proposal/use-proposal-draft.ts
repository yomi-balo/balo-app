'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import {
  PROPOSAL_DRAFT_MAX_POLLS,
  PROPOSAL_DRAFT_POLL_INTERVAL_MS,
} from '@balo/shared/project-requests';
import { track, PROJECT_EVENTS, type ProjectEventMap } from '@/lib/analytics';
import { startProposalDraftAction } from '@/app/(dashboard)/projects/[requestId]/_actions/start-proposal-draft';
import { getProposalDraftAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-proposal-draft';
import type {
  ProposalDraftGenerationView,
  ProposalDraftPatch,
} from '@/lib/project-request/proposal/proposal-draft-types';

type ProposalDraftSection =
  ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED]['section'];

type DraftPhase = 'idle' | 'drafting' | 'failed';

interface DraftUiState {
  phase: DraftPhase;
  overviewDrafted: boolean;
  milestonesDrafted: boolean;
}

interface UseProposalDraftOptions {
  /** False in revise mode, once a proposal exists, or when the page loaded no generation. */
  enabled: boolean;
  requestId: string;
  relationshipId: string;
  /** The server-loaded generation view, or null when the composer must not draft. */
  initial: ProposalDraftGenerationView | null;
  /** Apply a freshly drafted patch to the composer. Not called for a draft already applied. */
  onDraft: (patch: ProposalDraftPatch) => void;
}

interface UseProposalDraftResult {
  /** A generation is running: the sections draw their skeletons. */
  drafting: boolean;
  /** Drafting failed or timed out: show the quiet line and leave the composer blank. */
  failed: boolean;
  overviewDrafted: boolean;
  milestonesDrafted: boolean;
  /** The expert edited a section. While drafting, this discards the whole draft. */
  noteEdit: (section: ProposalDraftSection) => void;
  /** The expert cleared a drafted section with its Clear control. */
  noteClear: (section: ProposalDraftSection) => void;
  /** An Undo put a cleared section's drafted content back: its badge returns with it. */
  noteRestore: (section: ProposalDraftSection) => void;
}

const IDLE: DraftUiState = { phase: 'idle', overviewDrafted: false, milestonesDrafted: false };

function initialUiState(
  enabled: boolean,
  initial: ProposalDraftGenerationView | null
): DraftUiState {
  if (!enabled || initial === null) return IDLE;
  switch (initial.status) {
    case 'succeeded':
      return { phase: 'idle', overviewDrafted: true, milestonesDrafted: true };
    case 'failed':
      return { ...IDLE, phase: 'failed' };
    case 'none':
    case 'pending':
      return { ...IDLE, phase: 'drafting' };
    case 'skipped':
      return IDLE;
  }
}

interface DraftRun {
  cancelled: boolean;
  /** Marks the run cancelled and clears its pending poll timer. */
  stop: () => void;
}

/**
 * Drives the one automatic AI draft of a composer (BAL-611). When the server found no
 * generation the hook starts one (idempotent per relationship, so a StrictMode double mount
 * or a second tab is safe); when one is pending it polls it every
 * `PROPOSAL_DRAFT_POLL_INTERVAL_MS`. A draft that already succeeded on the server was applied
 * to the composer's first render, so the hook only turns its badges on.
 *
 * Polling stops only on a terminal view (`succeeded`, `failed` or `skipped`). The server owns
 * the deadline: its read derives `failed` for a `pending` row past `DRAFT_DEADLINE_MS`, so the
 * hook keeps no countdown of its own. `PROPOSAL_DRAFT_MAX_POLLS` is a safety cap that strictly
 * outlasts that deadline and is reached only when the reads never turn terminal; it shows the
 * same quiet failure line.
 *
 * The first edit to either section while drafting stops the run and discards the whole
 * draft (tracked once as `PROPOSAL_DRAFT_DISCARDED`), so a late result never overwrites what
 * the expert typed. Unmount stops polling.
 */
export function useProposalDraft({
  enabled,
  requestId,
  relationshipId,
  initial,
  onDraft,
}: Readonly<UseProposalDraftOptions>): UseProposalDraftResult {
  const [ui, setUi] = useState<DraftUiState>(() => initialUiState(enabled, initial));
  const uiRef = useRef(ui);
  const runRef = useRef<DraftRun | null>(null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const initialRef = useRef(initial);

  const commit = useCallback((next: DraftUiState): void => {
    uiRef.current = next;
    setUi(next);
  }, []);

  useEffect(() => {
    const initialView = initialRef.current;
    if (!enabled || initialView === null || uiRef.current.phase !== 'drafting') return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;
    const run: DraftRun = {
      cancelled: false,
      stop: () => {
        run.cancelled = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
    runRef.current = run;

    function fail(): void {
      commit({ ...IDLE, phase: 'failed' });
    }

    function handle(view: ProposalDraftGenerationView): void {
      if (run.cancelled) return;
      switch (view.status) {
        case 'succeeded':
          onDraftRef.current(view.patch);
          commit({ phase: 'idle', overviewDrafted: true, milestonesDrafted: true });
          return;
        case 'pending':
          schedulePoll(view.generationId);
          return;
        case 'failed':
          fail();
          return;
        case 'none':
        case 'skipped':
          commit(IDLE);
          return;
      }
    }

    function schedulePoll(generationId: string): void {
      timer = setTimeout(() => {
        polls += 1;
        getProposalDraftAction({ requestId, relationshipId, generationId })
          .then((view) => {
            if (run.cancelled) return;
            if (view.status === 'pending' && polls >= PROPOSAL_DRAFT_MAX_POLLS) {
              fail();
              return;
            }
            handle(view);
          })
          .catch((error: unknown) => {
            Sentry.captureException(error);
            if (!run.cancelled) fail();
          });
      }, PROPOSAL_DRAFT_POLL_INTERVAL_MS);
    }

    if (initialView.status === 'pending') {
      schedulePoll(initialView.generationId);
    } else {
      startProposalDraftAction({ requestId, relationshipId })
        .then(handle)
        .catch((error: unknown) => {
          Sentry.captureException(error);
          if (!run.cancelled) fail();
        });
    }

    return run.stop;
  }, [enabled, requestId, relationshipId, commit]);

  const noteEdit = useCallback(
    (section: ProposalDraftSection): void => {
      const current = uiRef.current;
      if (current.phase === 'drafting') {
        runRef.current?.stop();
        commit(IDLE);
        track(PROJECT_EVENTS.PROPOSAL_DRAFT_DISCARDED, { relationship_id: relationshipId });
        return;
      }
      const next: DraftUiState = {
        phase: 'idle',
        overviewDrafted: section === 'overview' ? false : current.overviewDrafted,
        milestonesDrafted: section === 'milestones' ? false : current.milestonesDrafted,
      };
      if (
        next.phase !== current.phase ||
        next.overviewDrafted !== current.overviewDrafted ||
        next.milestonesDrafted !== current.milestonesDrafted
      ) {
        commit(next);
      }
    },
    [commit, relationshipId]
  );

  const noteClear = useCallback(
    (section: ProposalDraftSection): void => {
      track(PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED, { section, relationship_id: relationshipId });
      const current = uiRef.current;
      commit({
        ...current,
        overviewDrafted: section === 'overview' ? false : current.overviewDrafted,
        milestonesDrafted: section === 'milestones' ? false : current.milestonesDrafted,
      });
    },
    [commit, relationshipId]
  );

  const noteRestore = useCallback(
    (section: ProposalDraftSection): void => {
      const current = uiRef.current;
      commit({
        ...current,
        overviewDrafted: section === 'overview' ? true : current.overviewDrafted,
        milestonesDrafted: section === 'milestones' ? true : current.milestonesDrafted,
      });
    },
    [commit]
  );

  return {
    drafting: ui.phase === 'drafting',
    failed: ui.phase === 'failed',
    overviewDrafted: ui.overviewDrafted,
    milestonesDrafted: ui.milestonesDrafted,
    noteEdit,
    noteClear,
    noteRestore,
  };
}
