import 'server-only';

import {
  conversationsRepository,
  projectRequestsRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { resolveRequestLens, type RequestViewerContext } from './resolve-request-lens';
import { isThreadOpenStatus } from './conversation-view-types';

/**
 * Per-action conversation guard (BAL-271 / A4) — the multi-thread extension of
 * the BAL-270 IDOR pattern. Every conversation Server Action takes the
 * `relationshipId` ONLY as a CLAIM and validates it here against the
 * server-loaded request graph + the viewer's resolved lens:
 *
 *  - viewer must be a PARTICIPANT (admin observers are denied — A4 has no
 *    admin chat);
 *  - expert lens → the claimed id MUST equal the viewer's own relationship;
 *  - client lens → the claimed id must be one of the OWNED request's live
 *    relationships with an OPEN thread status;
 *  - both lenses → the relationship's thread must be open
 *    (`THREAD_OPEN_RELATIONSHIP_STATUSES`).
 *
 * Error copy is uniform so probing leaks nothing about other requests/threads.
 *
 * BAL-424: this is the `relationship` arm of the ADR-1045 §2 tenancy obligation —
 * it resolves the owning party through the request graph before it will name a
 * conversation. The `engagement` arm is
 * `@/lib/conversations/authorize-conversation-context`.
 */

const DENIED = 'You do not have access to this conversation.';

export type ConversationAccess =
  | {
      ok: true;
      ctx: RequestViewerContext;
      request: ProjectRequestWithRelations;
      relationship: ProjectRequestWithRelations['relationships'][number];
      /**
       * BAL-424 — the thread this relationship anchors. Resolved AFTER authorization,
       * never before: an unauthenticated or non-participant caller must not be able to
       * make this function write a row.
       *
       * ⚠ `ensureForContext`, NOT `findByContext`. `invite()` provisions eagerly so this
       * is a read hit in practice, but a get-or-create removes the alternative — a
       * nullable `conversationId` threaded through 8 call sites, 3 wire types and 2 view
       * builders, every one of which would need a "no thread yet" branch that can only
       * ever be dead. The write is idempotent and bounded: at most one row per
       * relationship, ever.
       */
      conversationId: string;
      /** The OTHER party — who a posted message/file notifies. */
      recipient: { role: 'client'; userId: string } | { role: 'expert'; expertProfileId: string };
    }
  | { ok: false; error: string };

/**
 * {@link readConversationAccess}'s answer. Identical to {@link ConversationAccess} except
 * that `conversationId` may be `undefined` — a thread that was never provisioned is an EMPTY
 * thread, which is what a READ should report rather than minting one to avoid the branch.
 */
export type ConversationReadAccess =
  | {
      ok: true;
      ctx: RequestViewerContext;
      request: ProjectRequestWithRelations;
      relationship: ProjectRequestWithRelations['relationships'][number];
      /** `undefined` when no thread has been provisioned yet ⇒ read as empty. */
      conversationId: string | undefined;
      recipient: { role: 'client'; userId: string } | { role: 'expert'; expertProfileId: string };
    }
  | { ok: false; error: string };

function denied(
  user: SessionUser,
  requestId: string,
  relationshipId: string,
  lens: string | null
): ConversationAccess {
  log.warn('Conversation access denied', {
    requestId,
    relationshipId,
    userId: user.id,
    lens,
  });
  return { ok: false, error: DENIED };
}

/** Everything the gate proves BEFORE any conversation row is read or written. */
type AuthorizedThread =
  | {
      ok: true;
      ctx: RequestViewerContext;
      request: ProjectRequestWithRelations;
      relationship: ProjectRequestWithRelations['relationships'][number];
      recipient: { role: 'client'; userId: string } | { role: 'expert'; expertProfileId: string };
    }
  | { ok: false; error: string };

/**
 * THE AUTHORIZATION CORE, shared by both variants below. It performs NO conversation I/O at
 * all — which is what lets the read-only variant stay genuinely read-only while both run
 * byte-identical checks in byte-identical order.
 */
async function authorizeThread(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<AuthorizedThread> {
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return denied(user, requestId, relationshipId, null);
  }

  const ctx = resolveRequestLens(user, request);
  if (ctx?.archetype !== 'participant') {
    return denied(user, requestId, relationshipId, ctx?.lens ?? null);
  }

  // Expert lens may only ever touch their OWN thread.
  if (ctx.lens === 'expert' && relationshipId !== ctx.relationshipId) {
    return denied(user, requestId, relationshipId, ctx.lens);
  }

  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined || !isThreadOpenStatus(relationship.status)) {
    return denied(user, requestId, relationshipId, ctx.lens);
  }

  // The recipient is the OTHER party: sender client → recipient expert;
  // sender expert → recipient client (the request owner's user).
  const recipient =
    ctx.lens === 'client'
      ? ({ role: 'expert', expertProfileId: relationship.expertProfileId } as const)
      : ({ role: 'client', userId: request.createdByUserId } as const);

  return { ok: true, ctx, request, relationship, recipient };
}

/**
 * The WRITING variant — for MUTATING actions only (post, mark-read, presign, confirm,
 * request-proposal). Get-or-creates the thread, so `conversationId` is non-nullable.
 *
 * ⚠ IT WRITES, TRANSITIVELY. Every caller must therefore authenticate with
 * `requireOnboardedUser()`, and none may sit on `onboarding-mutation-gate.test.ts`'s
 * `READ_ONLY_ALLOWLIST` — that invariant test inspects the action file's own source and
 * cannot see a write reached through an import. Read-only callers use
 * {@link readConversationAccess} instead.
 */
export async function resolveConversationAccess(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<ConversationAccess> {
  const authorized = await authorizeThread(user, requestId, relationshipId);
  if (!authorized.ok) {
    return authorized;
  }

  // AUTHORIZATION IS COMPLETE ABOVE THIS LINE. Only now may we touch (and, if it is
  // somehow missing, mint) the thread — see `ConversationAccess.conversationId`.
  const { conversation, created } = await conversationsRepository.ensureForContext({
    contextType: 'relationship',
    contextId: relationshipId,
  });
  if (created) {
    // `invite()` provisions eagerly, so a create here is BOTH a business event and a signal
    // that this relationship predates the seam. Logged only on the create, never on the
    // read hit — and only on the `ok` path, so a denial can never confirm a thread exists.
    log.info('Conversation provisioned', {
      requestId,
      relationshipId,
      conversationId: conversation.id,
      userId: user.id,
    });
  }

  return { ...authorized, conversationId: conversation.id };
}

/**
 * The READ-ONLY variant — identical authorization, `findByContext` instead of
 * `ensureForContext`, and therefore NO WRITE ON ANY PATH.
 *
 * ⚠ WHY IT EXISTS. `fetch-thread.ts` and `get-conversation-file-download.ts` authenticate
 * with bare `requireUser()` and sit on `READ_ONLY_ALLOWLIST` with justifications ("pure
 * read", "no mutation"). Once `resolveConversationAccess` began get-or-creating, those two
 * became TRANSITIVE WRITERS and their allowlist entries became false — invisibly, because the
 * invariant test reads the action's own source and the write arrives through an import. An
 * un-onboarded member could insert rows. Keeping them genuinely read-only restores the
 * invariant instead of relaxing it.
 *
 * ⚠ `conversationId` IS OPTIONAL HERE, AND THAT IS THE CORRECT READ SEMANTICS: a thread that
 * has not been provisioned is an EMPTY thread, not an error. Eager provisioning at `invite()`
 * / `create()` means it is present in practice; both callers render empty rather than fail.
 */
export async function readConversationAccess(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<ConversationReadAccess> {
  const authorized = await authorizeThread(user, requestId, relationshipId);
  if (!authorized.ok) {
    return authorized;
  }

  const conversation = await conversationsRepository.findByContext({
    contextType: 'relationship',
    contextId: relationshipId,
  });

  return { ...authorized, conversationId: conversation?.id };
}
