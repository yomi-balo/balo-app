'use client';

import { useCallback, useEffect, useRef } from 'react';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import type { ProjectRequestEntryPoint } from '@balo/shared/project-requests';
import type { ProjectRouting } from './send-to-selector';

interface UseProjectRoutingArgs {
  open: boolean;
  step: ProjectStep;
  routing: ProjectRouting;
  /** Undefined on a context-free mount — routing is fixed to Match there. */
  expertProfileId: string | undefined;
  expertAvailableForWork: boolean | undefined;
  /** Which surface raised the unavailable notice: the profile's own data, or a refused submit. */
  unavailableTrigger: 'profile_data' | 'submit_rejected';
  entryPoint: ProjectRequestEntryPoint;
  setRouting: (next: ProjectRouting) => void;
}

interface UseProjectRoutingResult {
  /** Direct is selected for an expert who isn't taking on new work — submit must stay disabled. */
  directBlocked: boolean;
  changeRouting: (next: ProjectRouting) => void;
  /** The review-step "Get matched instead": switches to Match, then focuses the submit button. */
  matchInsteadFromReview: () => void;
  /** Attach to the review step's submit button. */
  submitButtonRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * Routing changes for an expert-bound request, with their analytics: the toggle between Direct and
 * Match, the "expert isn't taking on new work" blocked state, and the two funnel events that
 * describe them. A context-free mount has no expert to route to, so `changeRouting` is a no-op
 * there.
 */
export function useProjectRouting({
  open,
  step,
  routing,
  expertProfileId,
  expertAvailableForWork,
  unavailableTrigger,
  entryPoint,
  setRouting,
}: Readonly<UseProjectRoutingArgs>): UseProjectRoutingResult {
  const directBlocked =
    expertProfileId !== undefined && expertAvailableForWork === false && routing === 'direct';

  const changeRouting = useCallback(
    (next: ProjectRouting) => {
      if (expertProfileId === undefined || next === routing) return;
      setRouting(next);
      track(PROJECT_EVENTS.PROJECT_ROUTING_SWITCHED, {
        from: routing,
        to: next,
        entry_point: entryPoint,
        expert_id: expertProfileId,
      });
    },
    [expertProfileId, routing, setRouting, entryPoint]
  );

  const unavailableShownFor = useRef<string | null>(null);
  const noticeVisible = open && directBlocked && (step === 'manual' || step === 'review');
  useEffect(() => {
    if (!noticeVisible || expertProfileId === undefined) return;
    if (unavailableShownFor.current === expertProfileId) return;
    unavailableShownFor.current = expertProfileId;
    track(PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN, {
      expert_id: expertProfileId,
      entry_point: entryPoint,
      trigger: unavailableTrigger,
    });
  }, [noticeVisible, expertProfileId, entryPoint, unavailableTrigger]);

  // The review-step notice unmounts when the client switches to Match; once the submit button is
  // live again, focus moves to it so the keyboard user lands on the next action.
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const focusSubmitRef = useRef(false);
  useEffect(() => {
    if (!focusSubmitRef.current || directBlocked) return;
    focusSubmitRef.current = false;
    submitButtonRef.current?.focus();
  }, [directBlocked]);

  const matchInsteadFromReview = useCallback(() => {
    focusSubmitRef.current = true;
    changeRouting('match');
  }, [changeRouting]);

  return { directBlocked, changeRouting, matchInsteadFromReview, submitButtonRef };
}
