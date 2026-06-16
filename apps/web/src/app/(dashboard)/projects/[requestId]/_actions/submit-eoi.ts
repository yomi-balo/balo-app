'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  expressionsOfInterestRepository,
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
 * Branch first-EOI vs resubmit off the relationship status + live-EOI presence and
 * persist the EOI, returning its id (or a friendly stale-state error). Split out of
 * the action so the action's cognitive complexity stays under the gate. `submit()`
 * advances the relationship AND derives the request rollup atomically (ADR-1025 /
 * BAL-295); `resubmit()` moves neither.
 */
async function persistEoi(
  rel: Relationship,
  relationshipId: string,
  safeHtml: string
): Promise<{ ok: true; eoiId: string } | { ok: false; error: string }> {
  const hasLiveEoi = rel.expressionsOfInterest.length > 0;
  if (rel.status === 'invited') {
    const eoi = await expressionsOfInterestRepository.submit({ relationshipId, message: safeHtml });
    return { ok: true, eoiId: eoi.id };
  }
  if (rel.status === 'eoi_submitted' && !hasLiveEoi) {
    const eoi = await expressionsOfInterestRepository.resubmit({
      relationshipId,
      message: safeHtml,
    });
    return { ok: true, eoiId: eoi.id };
  }
  if (rel.status === 'eoi_submitted' && hasLiveEoi) {
    return { ok: false, error: 'You already have an active EOI. Withdraw it first to resubmit.' };
  }
  return { ok: false, error: 'You can no longer submit an EOI for this request.' };
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
 *  - first EOI (relationship `invited`) → `submit()` — atomically advances the
 *    relationship AND derives the request-level status (ADR-1025 / BAL-295), so no
 *    separate request transition is issued here;
 *  - resubmit (relationship `eoi_submitted`, no live EOI) → `resubmit()`, which
 *    does not move the relationship and so leaves the request status unchanged;
 *  - already has a live EOI → friendly pre-check error.
 *
 * The `transitioned` analytics flag is re-sourced by comparing the request status
 * BEFORE vs a fresh `findById` re-read AFTER the relationship op — truthful (reads
 * the committed post-derivation status) without re-issuing the now-redundant
 * request transition.
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

    // Persist the EOI (first-submit or resubmit). `submit()` derives the
    // request-level status atomically (ADR-1025 / BAL-295); `request.status`
    // captured here is the pre-op floor.
    const beforeStatus = request.status;
    const persisted = await persistEoi(rel, relationshipId, safeHtml);
    if (!persisted.ok) {
      return { success: false, error: persisted.error };
    }
    const eoiId = persisted.eoiId;

    // Re-source the `transitioned` flag from the now-coherent stored column
    // (ADR-1025 / BAL-295): compare the pre-op floor against a fresh re-read. The
    // request rollup advanced atomically inside `submit()`; a re-read that races
    // past it (another expert advancing concurrently) is the same race-tolerant
    // snapshot semantics the old explicit transition had.
    const after = await projectRequestsRepository.findById(requestId);
    const transitioned = after !== undefined && after.status !== beforeStatus;

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
