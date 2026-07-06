'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, companiesRepository, proposalsRepository } from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

const NOT_ALLOWED = 'You do not have permission to do this.';
const REQUEST_GONE = 'This request can no longer take a billing reminder.';
const NOT_ON_REQUEST = 'This expert is not on this request.';
const STALE = 'This request is no longer awaiting kickoff.';
const GENERIC_FAILURE = 'Could not send the reminder. Please try again.';

const DAY_MS = 1000 * 60 * 60 * 24;

export type RemindClientBillingResult =
  | {
      success: true;
      companyId: string;
      /** 1 = owner only; 2 = owner + creator (creator ≠ owner AND a company member). */
      recipientCount: number;
      adminUserId: string;
      /** Whole days since proposal acceptance; `null` when none resolves (decision #5). */
      daysSinceAcceptance: number | null;
    }
  | { success: false; error: string };

/**
 * Whether `userId` belongs to `companyId` (decision #2). Reads through the
 * companies repository — a member row keyed to this company. Guards the
 * creator-FYI fan-out so a "your company's billing is incomplete" heads-up never
 * lands on an admin acting on-behalf (BAL-315) or any non-member.
 */
async function isCompanyMember(userId: string, companyId: string): Promise<boolean> {
  const company = await companiesRepository.findWithMembers(companyId);
  return company?.members.some((m) => m.userId === userId) ?? false;
}

/**
 * Whole days since the proposal was accepted (decision #5). `project_requests` has
 * NO `acceptedAt` column, so we derive it from the accepted relationship's CURRENT
 * proposal, which stamps `acceptedAt` on its transition to `accepted` (proposals
 * repo). Prefer that precise timestamp; fall back to the proposal row's `updatedAt`
 * if it is somehow unset. Returns `null` when no proposal resolves.
 */
async function computeDaysSinceAcceptance(relationshipId: string): Promise<number | null> {
  const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (proposal === undefined) return null;
  const acceptedAt = proposal.acceptedAt ?? proposal.updatedAt;
  return Math.floor((Date.now() - acceptedAt.getTime()) / DAY_MS);
}

type HydratedProjectRequest = NonNullable<
  Awaited<ReturnType<typeof projectRequestsRepository.findByIdWithRelations>>
>;

interface ReminderRecipients {
  ownerUserId: string;
  /** true when the request creator also receives an FYI (decision #2). */
  creatorNotified: boolean;
}

/**
 * Resolves the reminder's recipients: the company OWNER (always) and whether the
 * request CREATOR gets an FYI — only when the creator is a different person than
 * the owner AND a company member (never an admin-on-behalf, BAL-315). Returns
 * `null` (already logged) when the owner cannot be resolved; a thrown
 * `isCompanyMember` propagates to the caller's outer catch, exactly as before.
 */
async function resolveReminderRecipients(
  request: HydratedProjectRequest
): Promise<ReminderRecipients | null> {
  let ownerUserId: string;
  try {
    ownerUserId = (await companiesRepository.findOwnerByCompanyId(request.companyId)).id;
  } catch (error) {
    log.error('Failed to resolve company owner for billing reminder', {
      requestId: request.id,
      companyId: request.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }

  const creatorUserId = request.createdByUserId;
  const creatorNotified =
    creatorUserId !== ownerUserId && (await isCompanyMember(creatorUserId, request.companyId));
  return { ownerUserId, creatorNotified };
}

/**
 * Admin sends the client a "complete your billing details" reminder from the
 * kickoff board (BAL-324) while the `client_billing` gate is outstanding. Publishes
 * ONE `project.billing_reminder` event; the notification engine fans it out to the
 * OWNER (email + in-app, CTA) and — only when the request CREATOR is a different
 * person AND a company member — the creator (email + in-app FYI). `correlationId`
 * is minted PER CLICK so a deliberate re-remind is a genuinely new dispatch (not a
 * BullMQ jobId no-op), while per-recipient jobIds still dedup a single click's
 * retries. Analytics (`project_billing_reminder_sent`) is fired client-side by the
 * island from this result.
 *
 * Authorization: platform `admin`/`super_admin` via `requireAdmin()`. IDOR-safe:
 * the relationship must belong to the request (else `NOT_ON_REQUEST`).
 */
export async function remindClientBilling(
  input: z.infer<typeof inputSchema>
): Promise<RemindClientBillingResult> {
  let admin;
  try {
    // TODO(BAL-314): replace the platformRole gate with canActOnBehalf(admin, request).
    admin = await requireAdmin();
  } catch {
    return { success: false, error: NOT_ALLOWED };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: REQUEST_GONE };
    }

    // IDOR-safe: a foreign relationship id simply isn't in the hydrated graph.
    const relationship = request.relationships.find((r) => r.id === relationshipId);
    if (relationship === undefined) {
      return { success: false, error: NOT_ON_REQUEST };
    }

    if (request.status !== 'accepted') {
      return { success: false, error: STALE };
    }

    const recipients = await resolveReminderRecipients(request);
    if (recipients === null) {
      return { success: false, error: GENERIC_FAILURE };
    }
    const { ownerUserId, creatorNotified } = recipients;

    // Minted per click (uuid-valid) so a 2nd deliberate "Remind" is a fresh dispatch,
    // not a jobId no-op; per-recipient jobIds still dedup a single click's retries.
    const correlationId = crypto.randomUUID();

    const daysSinceAcceptance = await computeDaysSinceAcceptance(relationshipId);

    // Fire-and-forget — a notification hiccup must never fail the admin action. ONE
    // publish; the engine fans out to owner + (conditionally) creator rules.
    publishNotificationEvent('project.billing_reminder', {
      correlationId,
      projectRequestId: requestId,
      title: request.title,
      companyName: request.company.name,
      recipientId: ownerUserId,
      creatorUserId: creatorNotified ? request.createdByUserId : undefined,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    log.info('Billing reminder sent', {
      requestId,
      adminUserId: admin.id,
      recipientCount: creatorNotified ? 2 : 1,
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      companyId: request.companyId,
      recipientCount: creatorNotified ? 2 : 1,
      adminUserId: admin.id,
      daysSinceAcceptance,
    };
  } catch (error) {
    log.error('Failed to remind client billing', {
      requestId,
      relationshipId,
      adminUserId: admin.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
