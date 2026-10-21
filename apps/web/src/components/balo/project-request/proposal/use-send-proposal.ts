'use client';

import { useCallback, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { submitProposalAction } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal';
import {
  resubmitProposalAction,
  type ResubmitProposalInput,
} from '@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal';

/**
 * Revise-mode payload (A6.4 / BAL-290). When present, `send` performs a RESUBMIT
 * instead of a first submit: it calls `resubmitProposalAction` with the composer's
 * full payload (built by the composer at send time) and fires `PROPOSAL_RESUBMITTED`.
 */
interface ResubmitConfig {
  /** The version this resubmit will write. */
  nextVersion: number;
  /** Build the full resubmit payload at send time (latest composer state). */
  getPayload: () => ResubmitProposalInput;
}

interface UseSendProposalOptions {
  requestId: string;
  relationshipId: string;
  /** The client company named in the success toast. */
  companyName: string;
  /**
   * Flush a final autosave before submitting (Q2: trust the persisted draft).
   * Resolves to the proposalId that the server will submit, or null on failure.
   * Submit mode only (revise mode is local-only until the atomic resubmit).
   */
  onBeforeSubmit: () => Promise<string | null>;
  /** When present, `send` is a RESUBMIT (revise mode), not a first submit. */
  resubmit?: ResubmitConfig;
  /** Called once the proposal is sent, with the version it was written as. */
  onSent: (version: number) => void;
}

interface UseSendProposalResult {
  send: () => void;
  pending: boolean;
}

const SUBMIT_STALE_COPY = 'This proposal can no longer be submitted.';
const RESUBMIT_STALE_COPY = 'This proposal has already been resubmitted. Refresh to continue.';
const FIRST_VERSION = 1;

/** The route the page serves the sent screen from: the submit actions revalidate the
 *  path, so the composer is replaced server-side and the version rides in the URL. */
function sentUrl(pathname: string, version: number): string {
  return `${pathname}?sent=${version}`;
}

/**
 * The send/resend commit (A6.2 / BAL-288 + A6.4 / BAL-290, reshaped by BAL-610). Owns
 * its pending state and ignores `send` while one is in flight. In SUBMIT mode it
 * flushes a final autosave (`onBeforeSubmit`, Q2) and calls `submitProposalAction`
 * (which emits `PROJECT_PROPOSAL_SUBMITTED` server-side — BAL-357). In RESUBMIT mode
 * (the `resubmit` option) it calls `resubmitProposalAction` with the composer's full
 * payload and fires `PROPOSAL_RESUBMITTED`. On success it toasts and hands the written
 * version to `onSent` and routes to `?sent={version}`, which the page renders as the sent screen. A stale result toasts
 * and refreshes; a generic failure toasts and leaves the caller where it was to retry.
 */
export function useSendProposal({
  requestId,
  relationshipId,
  companyName,
  onBeforeSubmit,
  resubmit,
  onSent,
}: Readonly<UseSendProposalOptions>): UseSendProposalResult {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const isResubmit = resubmit !== undefined;

  const runSubmit = useCallback(async (): Promise<void> => {
    // Q2: flush a final autosave so the server submits what's stored.
    const effectiveProposalId = await onBeforeSubmit();
    if (effectiveProposalId === null) {
      toast.error('Could not submit your proposal. Please try again.');
      return;
    }

    const result = await submitProposalAction({
      requestId,
      relationshipId,
      proposalId: effectiveProposalId,
    });

    if (!result.success) {
      // Coherence rejection (defence-in-depth behind the inline readiness check) →
      // fire analytics with the raw rule; the UI only ever shows the generic copy.
      if (result.coherence) {
        track(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
          rule: result.coherence.rule,
          pricing_method: result.coherence.pricingMethod,
          entry_point: 'web',
          proposal_id: result.coherence.proposalId,
          relationship_id: result.coherence.relationshipId,
        });
      }
      toast.error(result.error);
      // Stale-UI copy → refresh (nothing to retry); otherwise stay to retry.
      if (result.error === SUBMIT_STALE_COPY) router.refresh();
      return;
    }

    // BAL-357: PROJECT_PROPOSAL_SUBMITTED is emitted SERVER-SIDE by the action so
    // the Balo fee + client-charged price never transit the browser. The client
    // only fires the non-sensitive events below.
    // BAL-294: effort is committed at submit (not per keystroke) — fire ONCE here
    // with the server-computed totals (0 minutes for Fixed, where effort is nulled).
    track(PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED, {
      proposal_id: effectiveProposalId,
      milestone_count: result.analytics.milestoneCount,
      total_estimated_minutes: result.analytics.totalEstimatedMinutes,
      pricing_method: result.analytics.pricingMethod,
    });
    if (result.transitioned) {
      track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
        request_id: requestId,
        from: 'proposal_requested',
        to: 'proposal_submitted',
        actor: 'expert',
      });
    }

    toast.success(`Proposal sent to ${companyName}`);
    router.replace(sentUrl(pathname, FIRST_VERSION), { scroll: true });
    onSent(FIRST_VERSION);
  }, [onBeforeSubmit, requestId, relationshipId, companyName, router, pathname, onSent]);

  const runResubmit = useCallback(
    async (config: ResubmitConfig): Promise<void> => {
      const result = await resubmitProposalAction(config.getPayload());

      if (!result.success) {
        if (result.coherence) {
          track(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
            rule: result.coherence.rule,
            pricing_method: result.coherence.pricingMethod,
            entry_point: 'web',
            proposal_id: result.coherence.proposalId,
            relationship_id: result.coherence.relationshipId,
          });
        }
        toast.error(result.error);
        if (result.error === RESUBMIT_STALE_COPY) router.refresh();
        return;
      }

      track(PROJECT_EVENTS.PROPOSAL_RESUBMITTED, {
        request_id: requestId,
        relationship_id: relationshipId,
        expert_id: result.expertProfileId,
        version: result.version,
        price_cents: result.analytics.priceCents,
        currency: result.analytics.currency,
      });

      toast.success(`Version ${result.version} sent to ${companyName}`);
      router.replace(sentUrl(pathname, result.version), { scroll: true });
      onSent(result.version);
    },
    [requestId, relationshipId, companyName, router, pathname, onSent]
  );

  const send = useCallback((): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);

    const run = async (): Promise<void> => {
      try {
        if (resubmit === undefined) {
          await runSubmit();
        } else {
          await runResubmit(resubmit);
        }
      } catch (error: unknown) {
        Sentry.captureException(error);
        toast.error(
          isResubmit
            ? 'Could not resubmit your proposal. Please try again.'
            : 'Could not submit your proposal. Please try again.'
        );
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    };
    run().catch((error: unknown) => {
      Sentry.captureException(error);
    });
  }, [resubmit, runResubmit, runSubmit, isResubmit]);

  return { send, pending };
}
