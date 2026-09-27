'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROJECT_NUDGE_THRESHOLD, projectScore } from '@/lib/marketing/project-intent';

/** How long an eligible score must hold before the nudge actually shows (ref L1935-1946). */
const NUDGE_SHOW_DELAY_MS = 500;

export interface UseProjectNudgeOptions {
  /** The hero search's current query text. */
  query: string;
  /** The number of products currently selected in the hero facet. */
  productCount: number;
  /** Whether the nudge is allowed to run at all — false outside consultation mode. */
  active: boolean;
  /** Fired exactly once per false→true transition of `visible`, with the score at that moment. */
  onShown: (score: number) => void;
}

export interface UseProjectNudgeResult {
  /** Whether the nudge pill should render. */
  visible: boolean;
  /** The current `projectScore` for `query`/`productCount` (used by the CTA/✕ analytics calls). */
  score: number;
  /** Hides the nudge until `query` is cleared to empty. */
  dismiss: () => void;
}

/**
 * BAL-582 §2 — the marketing home hero's intent-detection nudge. Ports the ref's asymmetric
 * effect (`marketing-home.jsx:1935-1946`): HIDING is immediate (same render, the moment the
 * query stops being eligible), SHOWING is debounced by `NUDGE_SHOW_DELAY_MS` so a nudge doesn't
 * flash on every keystroke while a query is still being typed.
 *
 * `eligible` folds `active`, dismissal and the score threshold into one boolean; `ready` is a
 * separate piece of state that a debounce effect flips to `true` `NUDGE_SHOW_DELAY_MS` after the
 * LAST change of `(eligible, query, productCount)` while `eligible` still holds — and is reset
 * to `false` (synchronously, in the same render as the state read) the instant `eligible` goes
 * false. `visible = eligible && ready`, so an ineligible render can never show a nudge stuck
 * `ready` from an earlier eligible spell.
 */
export function useProjectNudge({
  query,
  productCount,
  active,
  onShown,
}: UseProjectNudgeOptions): UseProjectNudgeResult {
  const [dismissed, setDismissed] = useState(false);
  const [ready, setReady] = useState(false);

  const score = useMemo(() => projectScore(query, productCount), [query, productCount]);
  const eligible = active && !dismissed && score >= PROJECT_NUDGE_THRESHOLD;

  // The debounce: only ever ARMS a "become ready" timer while eligible; going ineligible clears
  // readiness immediately instead of waiting out a stale timer.
  useEffect(() => {
    if (!eligible) {
      setReady(false);
      return undefined;
    }
    const timer = setTimeout(() => setReady(true), NUDGE_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [eligible, query, productCount]);

  // Clearing the query is the only thing that un-dismisses the nudge (ref L1945-1946).
  useEffect(() => {
    if (query.trim() === '') setDismissed(false);
  }, [query]);

  const visible = eligible && ready;

  // Read inside the visibility effect below via refs, not deps, so retyping while already
  // visible (a `query`/`score` change with `visible` unchanged) never re-fires `onShown` — only
  // an actual false→true transition of `visible` does.
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  useEffect(() => {
    if (visible) onShownRef.current(scoreRef.current);
  }, [visible]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return { visible, score, dismiss };
}
