/**
 * BAL-378 (ADR-1040 Lane 2) — the credit-session routes (§8). Thin Fastify controllers:
 * WorkOS-authed (`requireAuth` → `request.userId`), Zod-validated, delegating all logic to the
 * credit-session service. `open` gate codes map to 403 (forbidden) / 409 (money gates);
 * lifecycle errors map to 404 / 409.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExternalDurationConflictError,
  InvalidSessionTransitionError,
  SessionNotFoundError,
  usersRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { platformRoleHasCapability, PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { requireAuth } from '../../lib/require-auth.js';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import {
  connectSession,
  endSession,
  finalizeExternalDuration,
  getSessionDrawdownState,
  nudgeAdminForTopup,
  openSession,
  resolveAdminMoneyBlock,
  resolveSessionMoneyBlock,
  type OpenSessionServiceErrorCode,
  type SessionActorErrorCode,
} from '../../services/credit-session/index.js';
import {
  finalizeDurationBodySchema,
  openSessionBodySchema,
  sessionIdParamsSchema,
} from './schema.js';

const log = createLogger('sessions-route');

/** `forbidden` → 403 (capability); every money gate (incl. `session_in_progress`) → 409. */
function openErrorStatus(code: OpenSessionServiceErrorCode): number {
  return code === 'forbidden' ? 403 : 409;
}

/** Actor authorization outcome → HTTP: `not_found` → 404 (also hides existence), `forbidden` → 403. */
function sessionActorErrorStatus(code: SessionActorErrorCode): number {
  return code === 'not_found' ? 404 : 403;
}

/** Resolve the authed user id, or 401 (defensive — `requireAuth` populates it). */
function resolveUserId(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = request.userId;
  if (userId === undefined) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

/** Parse the `:id` param, or send 400 and return null. */
function parseSessionId(request: FastifyRequest, reply: FastifyReply): string | null {
  const parsed = sessionIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_session_id' });
    return null;
  }
  return parsed.data.id;
}

/** Map a thrown lifecycle error to a status (404 / 409); null ⇒ unhandled (→ 500). */
function lifecycleErrorStatus(error: unknown): number | null {
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof InvalidSessionTransitionError) return 409;
  // BAL-399: a second external finalize with disagreeing minutes is a conflict, not a 500.
  if (error instanceof ExternalDurationConflictError) return 409;
  return null;
}

export async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /sessions — open a pending session (gate + hold).
  fastify.post('/sessions', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;

    const parsed = openSessionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map((issue) => issue.message),
      });
      return;
    }

    const result = await openSession({
      initiatingMemberId: userId,
      expertProfileId: parsed.data.expertProfileId,
      estimatedMinutes: parsed.data.estimatedMinutes,
      ...(parsed.data.companyId === undefined ? {} : { companyId: parsed.data.companyId }),
    });

    if (!result.ok) {
      // BAL-401 — >1 eligible billing company, none chosen: surface the narrow list so the
      // caller can pick one. 409 (authorized-but-ambiguous); the client branches on `code`.
      if (result.code === 'company_selection_required') {
        reply.code(409).send({ code: result.code, companies: result.companies });
        return;
      }
      reply.code(openErrorStatus(result.code)).send({ code: result.code });
      return;
    }
    reply
      .code(201)
      .send({ sessionId: result.sessionId, status: result.status, holdId: result.holdId });
  });

  // POST /sessions/:id/connect — authorize → pending → active; returns the fresh DrawdownState.
  fastify.post('/sessions/:id/connect', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) return;

    try {
      const result = await connectSession(sessionId, userId);
      if (!result.ok) {
        reply.code(sessionActorErrorStatus(result.code)).send({ error: result.code });
        return;
      }
      const state = await getSessionDrawdownState(sessionId, userId);
      if (state === undefined) {
        reply.code(404).send({ error: 'session_not_found' });
        return;
      }
      reply.code(200).send(state);
    } catch (error) {
      const status = lifecycleErrorStatus(error);
      if (status === null) throw error;
      reply.code(status).send({ error: 'invalid_session_state' });
    }
  });

  // POST /sessions/:id/end — authorize → meter → release → accrual → settle.
  fastify.post('/sessions/:id/end', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) return;

    try {
      const outcome = await endSession(sessionId, userId);
      if (!outcome.ok) {
        reply.code(sessionActorErrorStatus(outcome.code)).send({ error: outcome.code });
        return;
      }
      reply.code(200).send(outcome.result);
    } catch (error) {
      const status = lifecycleErrorStatus(error);
      if (status === null) throw error;
      reply.code(status).send({ error: 'invalid_session_state' });
    }
  });

  // POST /sessions/:id/nudge — authorize → member asks billing admins to top up.
  fastify.post('/sessions/:id/nudge', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) return;

    const result = await nudgeAdminForTopup(sessionId, userId);
    if (!result.ok) {
      reply.code(sessionActorErrorStatus(result.code)).send({ error: result.code });
      return;
    }
    reply.code(202).send({ ok: true });
  });

  // GET /sessions/:id/drawdown-state — read-only pure projection (lens from MANAGE_BILLING).
  fastify.get(
    '/sessions/:id/drawdown-state',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;
      const sessionId = parseSessionId(request, reply);
      if (sessionId === null) return;

      const state = await getSessionDrawdownState(sessionId, userId);
      if (state === undefined) {
        reply.code(404).send({ error: 'session_not_found' });
        return;
      }
      reply.code(200).send(state);
    }
  );

  // GET /sessions/:id/money-block — BAL-399 recap money block. Lens resolved fail-closed:
  // company member → CLIENT lens; else the session's expert → EXPERT lens; else 404 (hides
  // existence). Admin (margin) lens is NEVER served here — only on the platform-gated route below.
  fastify.get(
    '/sessions/:id/money-block',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;
      const sessionId = parseSessionId(request, reply);
      if (sessionId === null) return;

      try {
        const result = await resolveSessionMoneyBlock(sessionId, userId);
        if (!result.ok) {
          reply.code(404).send({ error: 'session_not_found' });
          return;
        }
        reply.code(200).send(result.block);
      } catch (error) {
        log.error(
          {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to resolve session money block'
        );
        reply.code(503).send({ error: 'money_block_unavailable' });
      }
    }
  );

  // GET /admin/sessions/:id/money-block — BAL-399 ADMIN (margin-bearing) lens. Platform-staff
  // ONLY (hasPlatformCapability, ADR-1035). Never reachable by a company member or expert.
  fastify.get(
    '/admin/sessions/:id/money-block',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;
      const sessionId = parseSessionId(request, reply);
      if (sessionId === null) return;

      const user = await usersRepository.findById(userId);
      if (
        user === undefined ||
        !platformRoleHasCapability(user.platformRole, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
      ) {
        log.warn({ sessionId, userId }, 'Admin money-block denied — lacks platform capability');
        reply.code(403).send({ error: 'forbidden' });
        return;
      }

      try {
        // The service self-asserts MANAGE_PLATFORM_FEES too (defense-in-depth); the route already
        // denied above, so `forbidden` here is only reachable if the two ever diverge.
        const result = await resolveAdminMoneyBlock(sessionId, user.platformRole);
        if (!result.ok) {
          reply
            .code(result.code === 'forbidden' ? 403 : 404)
            .send({ error: result.code === 'forbidden' ? 'forbidden' : 'session_not_found' });
          return;
        }
        reply.code(200).send(result.block);
      } catch (error) {
        log.error(
          {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to resolve admin session money block'
        );
        reply.code(503).send({ error: 'money_block_unavailable' });
      }
    }
  );

  // POST /internal/sessions/:id/finalize-duration — BAL-399 BAL-133 CONSUMER seam. System-authed
  // internal route (requireInternalAuth secret; NOT client-callable — the WorkOS-authed routes
  // above never expose duration finalization). BAL-133 produces the confirm/dispute UI + auto-
  // confirm sweep and CALLS this contract; the meeting.duration_confirm_* chain stays in BAL-133.
  fastify.post(
    '/internal/sessions/:id/finalize-duration',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const sessionId = parseSessionId(request, reply);
      if (sessionId === null) return;
      const parsed = finalizeDurationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'invalid_request',
          details: parsed.error.issues.map((issue) => issue.message),
        });
        return;
      }

      try {
        const result = await finalizeExternalDuration({
          sessionId,
          minutes: parsed.data.minutes,
          path: parsed.data.path,
          ...(parsed.data.settledByUserId === undefined
            ? {}
            : { settledByUserId: parsed.data.settledByUserId }),
        });
        reply.code(200).send(result);
      } catch (error) {
        const status = lifecycleErrorStatus(error);
        if (status === null) throw error;
        reply.code(status).send({ error: 'invalid_session_state' });
      }
    }
  );

  log.info('Registered credit-session routes');
}
