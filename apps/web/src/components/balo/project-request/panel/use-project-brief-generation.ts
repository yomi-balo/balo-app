'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { startProjectBriefParseAction } from '@/lib/project-request/actions/start-project-brief-parse';
import {
  getProjectBriefParseAction,
  type ProjectBriefDraftPatch,
} from '@/lib/project-request/actions/get-project-brief-parse';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';

const POLL_INTERVAL_MS = 2_000;
/** ~2 min — a ceiling, not a target. LLM structured extraction over a handful of small
 *  documents should resolve in single-digit-to-low-tens of seconds. */
const MAX_POLLS = 60;
const HEADING_STEPS_MS = [0, 5_000, 15_000] as const;

export type BriefGenerationPhase = 'idle' | 'generating' | 'failed';

export interface UseProjectBriefGenerationOptions {
  onSucceeded: (draft: ProjectBriefDraftPatch) => void;
}

export interface UseProjectBriefGenerationResult {
  phase: BriefGenerationPhase;
  headingIndex: 0 | 1 | 2;
  failureReason: ProjectBriefFailureReason | null;
  start: (documents: ProjectDocumentRef[]) => Promise<void>;
  dismissFailure: () => void;
}

/**
 * BAL-254 — the async-generation polling hook, shaped on `useCalendarPolling`
 * (`app/(dashboard)/expert/settings/_hooks/use-calendar-polling.ts`): a `setInterval`-driven
 * Server Action poll with an enable flag, a poll cap, and ref-guarded callbacks so re-renders
 * never restart the interval.
 *
 * ⚠ Reopening the drawer after a completed parse does NOT resume polling — `parseId` is
 * component state here, never draft state. Deliberate: a stale result silently overwriting a
 * hand-typed draft would be worse than losing it (§15 edge case).
 *
 * Unmount clears the interval — this is what makes "close the drawer" abort generation
 * client-side with no cancel button (the BullMQ job itself is not cancellable mid-flight and
 * does not need to be, per the design).
 */
export function useProjectBriefGeneration(
  options: UseProjectBriefGenerationOptions
): UseProjectBriefGenerationResult {
  const [phase, setPhase] = useState<BriefGenerationPhase>('idle');
  const [failureReason, setFailureReason] = useState<ProjectBriefFailureReason | null>(null);
  const [headingIndex, setHeadingIndex] = useState<0 | 1 | 2>(0);

  const onSucceededRef = useRef(options.onSucceeded);
  onSucceededRef.current = options.onSucceeded;

  const parseIdRef = useRef<string | null>(null);
  const pollCountRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  useEffect(() => clearPolling, [clearPolling]);

  const dismissFailure = useCallback(() => {
    setPhase('idle');
    setFailureReason(null);
  }, []);

  const start = useCallback(
    async (documents: ProjectDocumentRef[]) => {
      clearPolling();
      // ⚠ FIX ROUND F4 — clearing the id, not just the interval, is what INVALIDATES every poll
      // the previous generation already has in flight. See the generation guard below.
      parseIdRef.current = null;
      setPhase('generating');
      setFailureReason(null);
      setHeadingIndex(0);

      let result: Awaited<ReturnType<typeof startProjectBriefParseAction>>;
      try {
        result = await startProjectBriefParseAction({ documents });
      } catch (error) {
        // ⚠⚠ FIX ROUND F3 — THE PERMANENT SPINNER. This await can THROW, not just resolve
        // unsuccessfully: `withAuth` throws on an expired session, and the repository write
        // throws on a DB error. Without this catch `phase` stayed `'generating'` forever — no
        // interval had been created yet, so `MAX_POLLS` could never rescue it, and the caller's
        // `.catch(() => {})` swallowed the rejection in silence. Every escape has to end at a
        // TERMINAL phase so the error banner renders.
        //
        // ⚠ `Sentry.captureException`, NOT `@/lib/logging` — this is a client component, and the
        // web logger pulls in Pino → `async_hooks` (memory
        // `reference_client_components_cannot_import_web_logger`).
        Sentry.captureException(error);
        setPhase('failed');
        setFailureReason('unknown');
        return;
      }

      if (!result.success || result.parseId === undefined) {
        setPhase('failed');
        setFailureReason('enqueue_failed');
        return;
      }

      // ⚠⚠ FIX ROUND F4 — THE GENERATION IDENTITY, captured HERE, at issue time. Every poll this
      // interval issues closes over THIS id and compares it against `parseIdRef.current` before
      // touching any state. Without that, a poll left over from a previous generation resolves
      // after a retry/regenerate has already started, calls `clearPolling()` — killing the NEW
      // interval, so the new generation polls exactly once and then hangs — and writes the OLD
      // draft over the new one.
      const parseId = result.parseId;
      parseIdRef.current = parseId;
      pollCountRef.current = 0;

      /** True while `parseId` is still the generation the hook is actually running. */
      const isCurrentGeneration = (): boolean => parseIdRef.current === parseId;

      intervalRef.current = setInterval(() => {
        pollCountRef.current += 1;
        const elapsedMs = pollCountRef.current * POLL_INTERVAL_MS;
        const nextHeadingIndex = HEADING_STEPS_MS.reduce<0 | 1 | 2>((acc, threshold, index) => {
          return elapsedMs >= threshold ? (index as 0 | 1 | 2) : acc;
        }, 0);
        setHeadingIndex(nextHeadingIndex);

        if (pollCountRef.current > MAX_POLLS) {
          clearPolling();
          parseIdRef.current = null;
          setPhase('failed');
          setFailureReason('timed_out');
          return;
        }

        getProjectBriefParseAction({ parseId })
          .then((poll) => {
            if (!isCurrentGeneration()) return;
            if (poll.status === 'pending') return;
            clearPolling();
            parseIdRef.current = null;
            if (poll.status === 'succeeded') {
              setPhase('idle');
              onSucceededRef.current(poll.draft);
              return;
            }
            setPhase('failed');
            setFailureReason(poll.failureReason);
          })
          .catch((error: unknown) => {
            if (!isCurrentGeneration()) return;
            Sentry.captureException(error);
            clearPolling();
            parseIdRef.current = null;
            setPhase('failed');
            setFailureReason('unknown');
          });
      }, POLL_INTERVAL_MS);
    },
    [clearPolling]
  );

  return { phase, headingIndex, failureReason, start, dismissFailure };
}
