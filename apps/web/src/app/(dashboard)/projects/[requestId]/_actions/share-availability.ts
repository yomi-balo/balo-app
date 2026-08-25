'use server';
import 'server-only';

import { z } from 'zod';
import { calendarRepository, requestExpertRelationshipsRepository } from '@balo/db';
// ⚠ `@balo/analytics/events` — the PURE constants subpath, never `/client`.
import { CONVERSATION_CALL_SURFACES } from '@balo/analytics/events';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasExpertDeliveryCapability } from '@/lib/authz/engagement';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { assertRelationshipBookable } from '@/lib/project-request/assert-relationship-bookable';
import { resolveBookingExpertDisplay } from '@/lib/booking/load-booking-context';
import type { ShareAvailabilityInput, ShareAvailabilityResult } from './share-availability-types';

/**
 * BAL-283 (Ruling 3) — `shareAvailabilityAction`, the EXPERT lens's "Propose times" flow (plan
 * §12.6). SHARE AVAILABILITY + NUDGE THE CLIENT. NOT a new proposal state machine, no held
 * slot, no dialog: a single confirmed action that (a) stamps
 * `request_expert_relationships.availability_shared_at` and (b) publishes
 * `conversation.availability_shared` for the notification engine to email the client party.
 * The client then books through the SAME `request_interaction` path as the client lens.
 */

const inputSchema = z.object({
  requestId: z.string().uuid(),
  relationshipId: z.string().uuid(),
  // ⚠ DERIVED, NOT RETYPED (round-1 W10) — see `ConversationCallSurface`'s docblock.
  surface: z.enum(CONVERSATION_CALL_SURFACES),
});

/**
 * Display-hint only (per the design's edge-case table): the share succeeds regardless of
 * calendar connection state. NEVER THROWS — a read failure degrades to `false`, which just
 * adds the supplementary warning line the client-side toast renders.
 */
async function resolveCalendarConnected(expertProfileId: string): Promise<boolean> {
  try {
    const connections = await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);
    return connections.some((c) => c.credentialStatus === 'ACTIVE');
  } catch (error) {
    log.warn('Calendar connection read failed while sharing availability; defaulting to false', {
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function shareAvailabilityAction(
  rawInput: ShareAvailabilityInput
): Promise<ShareAvailabilityResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { ok: false, code: 'not_permitted' };
  }

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Share-availability failed validation', {
      userId: user.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
    return { ok: false, code: 'invalid_request' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      log.warn('Share-availability denied — conversation access', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }

    const expertProfileId = access.relationship.expertProfileId;

    /**
     * ⚠ THE ENGAGEMENT AXIS, NOT A `lens ===` COMPARISON (ADR-1029 / ADR-1046). This mutation
     * writes a column and emails the counterparty, so it is gated on DELIVERY IDENTITY — the
     * question "is this actor on the delivery side of this expert profile?", answered by the
     * ONE shared holder rule (`hasExpertDeliveryCapability` → `buildHostContextForExpertProfile`
     * → `hostContextGrants`). It was previously `access.ctx.lens !== 'expert'`, which CLAUDE.md
     * forbids categorically: `lens` gates the VIEW, a capability gates the MUTATION. That
     * comparison also silently EXCLUDED the delivering expert's agency `owner`/`admin`, who
     * hold `manage_engagement` and are exactly the people who cover for an expert — and it
     * would have silently HANDED the right to any future lens widening (an agency-admin lens, a
     * delegate, ADR-1029 `representations`/BAL-313).
     *
     * `MANAGE_ENGAGEMENT` is the right token, not `HOST_MEETINGS`: sharing availability is an
     * administrative scheduling act, not a live in-meeting one. Agency role `expert` is NOT a
     * holder — that is the deliberate act-vs-visibility asymmetry ADR-1046 §7 records, and it
     * must not be "aligned" with `actorHasExpertSideVisibility`.
     *
     * Runs BEFORE `assertRelationshipBookable` so an actor who is not on the delivery side
     * never learns anything about the relationship's lifecycle.
     */
    const mayManage = await hasExpertDeliveryCapability(
      user,
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      expertProfileId,
      { contextType: 'request_interaction', contextId: relationshipId }
    );
    if (!mayManage) {
      log.warn('Share-availability denied — actor is not on the delivery side of this expert', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }

    const bookable = await assertRelationshipBookable(relationshipId);
    if (!bookable) {
      log.warn('Share-availability denied — relationship declined or withdrawn', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }

    const stamped =
      await requestExpertRelationshipsRepository.stampAvailabilityShared(relationshipId);
    if (stamped === undefined) {
      // The row moved (soft-deleted) between the read above and this write — treat as denied.
      log.warn('Share-availability denied — relationship no longer live at write time', {
        requestId,
        relationshipId,
        userId: user.id,
      });
      return { ok: false, code: 'not_permitted' };
    }
    const { previousSharedAt, sharedAt } = stamped;
    const isReshare = previousSharedAt !== null;

    log.info('Expert shared availability', {
      requestId,
      relationshipId,
      userId: user.id,
      isReshare,
    });

    const [expertDisplay, calendarConnected] = await Promise.all([
      resolveBookingExpertDisplay(expertProfileId),
      resolveCalendarConnected(expertProfileId),
    ]);
    /**
     * ⚠ `'An expert'`, NOT `'Your expert'` (round-1 W2). `load-booking-context.ts` degrades
     * `partyLabel` to the literal `'An expert'` when the profile read fails, and the two halves
     * are concatenated downstream — so a mismatched pair rendered *"Your expert @ An expert"*.
     * One fallback string, used by both halves; `personWithOrgLabel` then collapses the
     * duplicate to a single `'An expert'`.
     */
    const expertPersonName =
      [expertDisplay.firstName, expertDisplay.lastName].filter(Boolean).join(' ') || 'An expert';

    const sharedAtIso = sharedAt.toISOString();
    publishNotificationEvent('conversation.availability_shared', {
      /**
       * Per WRITE, never per relationship — see the payload's own docblock.
       *
       * ⚠ THE PREVIOUS STAMP IS PART OF THE KEY (round-1 W13). `sharedAtIso` alone is
       * MILLISECOND-resolution, so two tabs racing inside the same millisecond mint an
       * identical BullMQ jobId and the second publish is silently dropped — which is exactly
       * the "per state, not per write" failure this key was written to avoid. Appending the
       * prior stamp makes the key a function of the TRANSITION, so two writes can only collide
       * if they also observed the same predecessor, which the row-level update prevents.
       */
      correlationId: `${relationshipId}--${sharedAtIso}--${previousSharedAt?.getTime() ?? 0}`,
      requestId,
      requestTitle: access.request.title,
      relationshipId,
      recipientId: access.request.createdByUserId,
      expertProfileId,
      expertPersonName,
      expertPartyLabel: expertDisplay.partyLabel,
      sharedAtIso,
      previousSharedAtIso: previousSharedAt === null ? null : previousSharedAt.toISOString(),
    });

    return { ok: true, isReshare, calendarConnected, sharedAtIso };
  } catch (error) {
    log.error('Share-availability failed unexpectedly', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'failed' };
  }
}
