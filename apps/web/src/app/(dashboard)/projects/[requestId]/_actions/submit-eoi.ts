'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  expressionsOfInterestRepository,
  InvalidStatusTransitionError,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { isDescriptionEmpty } from '@/components/balo/rich-text-editor';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  // 20000 = coarse server DoS bound on the raw HTML payload. The UX min/max is a
  // PLAIN-TEXT limit (DESCRIPTION_MIN_TEXT / MAX_TEXT) enforced client-side via
  // `validateDescription`; this byte guard sits comfortably above 4000 chars.
  message: z.string().min(1).max(20000),
});

export type SubmitEoiResult =
  | {
      success: true;
      /** Whether the REQUEST-level status advanced `experts_invited → eoi_submitted`. */
      transitioned: boolean;
      relationshipId: string;
      expertProfileId: string;
      /** ms from the relationship invite → this EOI — fired client-side as analytics. */
      timeToEoiMs: number;
    }
  | { success: false; error: string };

type Relationship = ProjectRequestWithRelations['relationships'][number];

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505). postgres-js
 * surfaces driver errors with a string `.code`; we narrow `unknown` structurally
 * (no `any`) so a genuinely concurrent double-submit — two requests both passing
 * the in-tx live-EOI guard, then one hitting the live-EOI partial unique index —
 * maps to the friendly "already have an active EOI" copy instead of the generic
 * fallback. The common stale-UI case is already caught by the pre-check.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

/** Invited expert's display name for the client-facing notification body. */
function expertDisplayName(relationship: Relationship): string {
  const { user } = relationship.expertProfile;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : 'An expert';
}

/**
 * Expert EOI submission (BAL-270 / A3).
 *
 * IDOR-safe by construction: the input is `{ requestId, message }` ONLY — the
 * `relationshipId` is NEVER accepted from the client. It is derived server-side by
 * loading the request graph and resolving the viewer's lens (the same
 * authorization the page uses); the resolver only yields a `relationshipId` for a
 * LIVE, non-declined relationship whose `expertProfileId === user.expertProfileId`.
 *
 * Branches off the hydrated relationship status + live-EOI presence:
 *  - first EOI (relationship `invited`) → `submit()` (atomically advances the
 *    relationship + inserts the EOI), then a caller-owned request-level transition
 *    `experts_invited → eoi_submitted` guarded to the FIRST EOI only;
 *  - resubmit (relationship `eoi_submitted`, no live EOI) → `resubmit()`, no
 *    request transition;
 *  - already has a live EOI → friendly pre-check error.
 *
 * Fires a client-facing `project.eoi_submitted` notification (fire-and-forget) and
 * returns `timeToEoiMs` for the island to attach to analytics.
 */
export async function submitEoiAction(
  input: z.infer<typeof inputSchema>
): Promise<SubmitEoiResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, message } = parsed.data;

  // SECURITY BOUNDARY: sanitise in the web caller before persist (never in @balo/db).
  const safeHtml = sanitizeProjectHtml(message);
  if (isDescriptionEmpty(safeHtml)) {
    return { success: false, error: 'Add a few words about why you’re a strong fit.' };
  }

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: 'This request no longer exists.' };
    }

    const ctx = resolveRequestLens(user, request);
    if (ctx === null || ctx.lens !== 'expert' || ctx.relationshipId === null) {
      return { success: false, error: 'You are not an invited expert on this request.' };
    }
    const relationshipId = ctx.relationshipId; // server-derived, never client-supplied

    const rel = request.relationships.find((r) => r.id === relationshipId);
    if (rel === undefined) {
      return { success: false, error: 'You are not an invited expert on this request.' };
    }
    const hasLiveEoi = rel.expressionsOfInterest.length > 0;

    // Branch first-vs-resubmit off the relationship status + live-EOI presence.
    let eoiId: string;
    let transitioned = false;
    if (rel.status === 'invited') {
      // FIRST EOI — `submit()` advances `invited → eoi_submitted` + inserts the EOI.
      const eoi = await expressionsOfInterestRepository.submit({
        relationshipId,
        message: safeHtml,
      });
      eoiId = eoi.id;

      // Caller-owned REQUEST-level transition, FIRST-EOI-ONLY: only when the request
      // is still `experts_invited`. A second expert's EOI arrives when the request is
      // already `eoi_submitted` → skip (the move would be illegal). `expectedFrom`
      // also defends a race where another expert advanced it between read and write.
      if (request.status === 'experts_invited') {
        try {
          await projectRequestsRepository.transitionStatus({
            id: requestId,
            to: 'eoi_submitted',
            expectedFrom: 'experts_invited',
          });
          transitioned = true;
        } catch (error) {
          if (error instanceof InvalidStatusTransitionError) {
            // The request reached `eoi_submitted` via another expert between our read
            // and write — same end-state. The EOI already persisted; not a user error.
            log.warn('EOI request transition skipped (already advanced by another expert)', {
              requestId,
            });
          } else {
            throw error;
          }
        }
      }
    } else if (rel.status === 'eoi_submitted' && !hasLiveEoi) {
      // RESUBMIT after a prior withdraw — insert a fresh EOI, NO request transition.
      const eoi = await expressionsOfInterestRepository.resubmit({
        relationshipId,
        message: safeHtml,
      });
      eoiId = eoi.id;
    } else if (rel.status === 'eoi_submitted' && hasLiveEoi) {
      return {
        success: false,
        error: 'You already have an active EOI. Withdraw it first to resubmit.',
      };
    } else {
      return { success: false, error: 'You can no longer submit an EOI for this request.' };
    }

    const resubmit = rel.status === 'eoi_submitted';
    log.info('EOI submitted', {
      requestId,
      relationshipId,
      userId: user.id,
      resubmit,
      transitioned,
    });

    // Fire-and-forget — notification failure must not block the expert's submit.
    publishNotificationEvent('project.eoi_submitted', {
      correlationId: eoiId,
      recipientId: request.createdByUserId,
      projectRequestId: requestId,
      title: request.title,
      expertName: expertDisplayName(rel),
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      transitioned,
      relationshipId,
      expertProfileId: rel.expertProfileId,
      timeToEoiMs: Date.now() - rel.invitedAt.getTime(),
    };
  } catch (error) {
    log.error('Failed to submit EOI', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // A concurrent double-submit can race past the in-tx live-EOI guard and trip
    // the partial unique index (23505) — surface the same friendly copy as the
    // pre-check rather than the generic fallback.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: 'You already have an active EOI. Withdraw it first to resubmit.',
      };
    }
    return { success: false, error: 'Could not submit your interest. Please try again.' };
  }
}
