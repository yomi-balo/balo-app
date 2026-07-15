'use server';
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  projectRequestsRepository,
  proposalsRepository,
  proposalShareLinksRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import {
  ensureClientProposalPdf,
  proposalPdfFileName,
} from '@/lib/project-request/proposal/pdf/ensure-client-pdf';
import { proposalPdfKey } from '@/lib/storage/proposal-pdf';
import { formatUtcLongDate } from '@/lib/format/local-date';
import { shareDisplayName } from '@/lib/project-request/proposal/share-view-types';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';

type Relationship = ProjectRequestWithRelations['relationships'][number];

export type ShareProposalResult =
  | { ok: true }
  | { ok: false; error: 'validation' | 'not_found' | 'forbidden' | 'send_failed' };

export type RevokeShareLinkResult = { ok: true } | { ok: false; error: 'not_found' | 'forbidden' };

const shareInputSchema = z.object({
  requestId: z.string().uuid(),
  relationshipId: z.string().uuid(),
  recipientEmail: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.string().email().max(254)
  ),
  note: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().max(1000).optional()
  ),
});

const revokeInputSchema = z.object({
  requestId: z.string().uuid(),
  relationshipId: z.string().uuid(),
  linkId: z.string().uuid(),
});

/** The domain part of an email for analytics — never the full address (PII). */
function emailDomain(email: string): string {
  const domain = email.split('@')[1];
  return domain !== undefined && domain.length > 0 ? domain : 'unknown';
}

interface AuthorizedShareContext {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  request: ProjectRequestWithRelations;
  relationship: Relationship;
}

/**
 * Resolve + authorize the request/relationship behind a share action. Mirrors the
 * BAL-385 PDF route gate: unknown request / unauthorized lens / relationship not on
 * the request → `not_found`; the EXPERT lens → `forbidden` (sharing is a
 * client-only surface, ADR-1029 capability). Returns the loaded context on success.
 */
async function authorizeShare(
  requestId: string,
  relationshipId: string
): Promise<AuthorizedShareContext | { error: 'not_found' | 'forbidden' }> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: 'not_found' };
  }
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (!request) {
    return { error: 'not_found' };
  }
  const ctx = resolveRequestLens(user, request);
  if (ctx === null) {
    return { error: 'not_found' };
  }
  if (ctx.lens === 'expert') {
    return { error: 'forbidden' };
  }
  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined) {
    return { error: 'not_found' };
  }
  return { user, request, relationship };
}

/**
 * Share the current client-facing proposal with an external colleague (BAL-386):
 * force-generate the client PDF to R2, mint an email-bound ≥256-bit magic-link
 * token (only its SHA-256 hash is stored), persist the link, and publish the
 * `proposal.shared` notification (email + PDF attachment). Analytics record the
 * recipient DOMAIN only — never the full email. The raw token rides ONLY in the
 * emailed URL; it is never returned to the caller, stored, or logged.
 */
export async function shareProposalWithColleague(input: {
  requestId: string;
  relationshipId: string;
  recipientEmail: string;
  note?: string;
}): Promise<ShareProposalResult> {
  const parsed = shareInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'validation' };
  }
  const { requestId, relationshipId, recipientEmail } = parsed.data;
  const note = parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : undefined;

  const authorized = await authorizeShare(requestId, relationshipId);
  if ('error' in authorized) {
    return { ok: false, error: authorized.error };
  }
  const { user, request, relationship } = authorized;

  const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (proposal === undefined || proposal.status === 'draft') {
    return { ok: false, error: 'not_found' };
  }

  try {
    // Force-generate the client PDF so the R2 object is present BEFORE the delivery
    // worker reads it by key (robust across BullMQ retries).
    await ensureClientProposalPdf({ request, relationship, proposal });

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const { link } = await proposalShareLinksRepository.create({
      relationshipId,
      recipientEmail,
      tokenHash,
      note: note ?? null,
      createdByUserId: user.id,
    });

    await publishNotificationEvent('proposal.shared', {
      correlationId: link.id,
      recipientEmail,
      shareToken: rawToken,
      sharerName: shareDisplayName(user),
      sharerOrgLabel: request.company?.name ?? 'their team',
      proposalTitle: request.title,
      note,
      expiresOn: formatUtcLongDate(link.expiresAt),
      attachments: [
        {
          source: 'r2',
          key: proposalPdfKey(proposal.id),
          filename: proposalPdfFileName(request.title, proposal.version),
        },
      ],
    });

    trackServerAndFlush(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_CREATED, {
      relationship_id: relationshipId,
      recipient_email_domain: emailDomain(recipientEmail),
      distinct_id: user.id,
    });

    log.info('Proposal shared with colleague', {
      relationshipId,
      recipientDomain: emailDomain(recipientEmail),
      shareLinkId: link.id,
    });

    revalidatePath(`/projects/${requestId}/proposal/${relationshipId}`);
    return { ok: true };
  } catch (error) {
    log.error('Proposal share failed', {
      relationshipId,
      recipientDomain: emailDomain(recipientEmail),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'send_failed' };
  }
}

/**
 * Revoke a share link inline from the sharer's "Shared with" list (BAL-386).
 * Authorizes the client lens, then revokes; guards that the revoked row actually
 * belongs to `relationshipId` so a client can never revoke another relationship's
 * link. The link's token stops resolving immediately.
 */
export async function revokeProposalShareLink(input: {
  requestId: string;
  relationshipId: string;
  linkId: string;
}): Promise<RevokeShareLinkResult> {
  const parsed = revokeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'not_found' };
  }
  const { requestId, relationshipId, linkId } = parsed.data;

  const authorized = await authorizeShare(requestId, relationshipId);
  if ('error' in authorized) {
    return { ok: false, error: authorized.error };
  }
  const { user } = authorized;

  // Pre-check membership BEFORE revoking so a mismatched linkId can never mutate
  // another relationship's link as a side effect — a client must only revoke a
  // link on the relationship it was presented (never confirm another exists).
  const activeLinks = await proposalShareLinksRepository.listActiveByRelationship(relationshipId);
  if (!activeLinks.some((link) => link.id === linkId)) {
    return { ok: false, error: 'not_found' };
  }

  const revoked = await proposalShareLinksRepository.revoke({ id: linkId, actorUserId: user.id });
  if (revoked === undefined) {
    return { ok: false, error: 'not_found' };
  }

  trackServerAndFlush(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_REVOKED, {
    share_link_id: linkId,
    distinct_id: user.id,
  });

  log.info('Proposal share link revoked', { relationshipId, shareLinkId: linkId });

  revalidatePath(`/projects/${requestId}/proposal/${relationshipId}`);
  return { ok: true };
}
