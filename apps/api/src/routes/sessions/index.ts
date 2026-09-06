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
// BAL-129 extracted this out of THIS file — it was byte-identical to the meetings route's copy.
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import type { RateLimitConfig } from '../../lib/rate-limiter.js';
import { createRateLimitPreHandler } from '../../lib/rate-limit-prehandler.js';
import {
  connectSession,
  endSession,
  finalizeExternalDuration,
  getSessionDrawdownState,
  nudgeAdminForTopup,
  openSession,
  resolveAdminMoneyBlock,
  resolveSessionMoneyBlock,
  resolveSessionStatement,
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

/**
 * BAL-519 — 60 req/min per USER on the statement read (D1/D2). The legitimate worst case for one
 * session is ≈5/min (the page, `generateMetadata` — deduped by `cache()` — the three bounded
 * poller refreshes, and one PDF), so 60 leaves room for a billing admin clicking through a
 * month of receipts while still bounding a loop.
 *
 * `:user` suffix per the dominant convention (`ratelimit:meeting-end:user`,
 * `ratelimit:meeting-state:user`, …): this bucket's defining property is that it is user-keyed,
 * and the key should say so in Redis and in Axiom.
 */
const STATEMENT_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:session-statement:user',
  maxRequests: 60,
  windowSeconds: 60,
};

/**
 * BAL-519 — the front-door limiter for `GET /sessions/:id/statement`, keyed on the AUTHENTICATED
 * user rather than the client IP: two users behind one office NAT get independent buckets, and one
 * user on two networks shares one.
 *
 * ⚠ REGISTERED AS A preHandler, AFTER `requireAuth` AND BEFORE THE HANDLER BODY — ON PURPOSE.
 * The lens gate lives INSIDE `resolveSessionStatement` (`services/credit-session/session-statement.ts`),
 * so a limit placed after it would let an attacker have the Postgres cost paid for them before
 * being refused (the BAL-461 lesson this ticket exists to apply). Fastify skips the route handler
 * once a hook has sent a reply (`fastify/lib/handle-request.js:120-121`, `lib/hooks.js:406-409`),
 * which makes "runs before the query" structurally true rather than true-by-line-position.
 *
 * ⚠ WHAT THIS DOES *NOT* BOUND. Because the limiter sits after `requireAuth`, a refused request
 * still pays one JWKS verify and one `usersRepository.findByWorkosId` SELECT (`lib/require-auth.ts:41,48`)
 * — that read is what establishes the identity the bucket is keyed on. The invariant delivered is
 * narrower and exact: `resolveSessionStatement` is never called, so the statement query, the lens
 * gate and the web-tier PDF render behind it are all bounded.
 *
 * FAIL-OPEN (D3), matching `/experts/search`: the cost of a miss here is a Postgres read plus one
 * render, not a third-party vendor round-trip, and there is no Redis-backed response cache in
 * front of this route — so the BAL-236 fail-closed rationale does not apply.
 */
const statementRateLimit = createRateLimitPreHandler({
  config: STATEMENT_RATE_LIMIT,
  failOpen: true,
  label: 'session-statement',
  identifier: (request) => request.userId,
  // The identifier here is an internal Balo user UUID, not a client IP — safe and useful to log.
  logIdentifier: true,
});

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

    const parsed = parseBodyOr400(openSessionBodySchema, request, reply);
    if (parsed === null) return;

    // ⚠ G1 (second review round) — `meetingId` is NOT on `openSessionBodySchema` and must never
    // be re-added here. See that schema's docblock: meeting-binding is a server decision made
    // by `joinMeetingAsMember`'s admission seam, never a wire input on this route.
    const result = await openSession({
      initiatingMemberId: userId,
      expertProfileId: parsed.expertProfileId,
      estimatedMinutes: parsed.estimatedMinutes,
      ...(parsed.companyId === undefined ? {} : { companyId: parsed.companyId }),
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

  // GET /sessions/:id/statement — BAL-441. Same fail-closed lens as /money-block (ONE resolver,
  // `resolveSessionLens`), plus the receipt-only context (date, subject, counterparty, back-link,
  // payout reference). NEVER serves the admin lens.
  fastify.get(
    '/sessions/:id/statement',
    // ORDER IS LOAD-BEARING: `requireAuth` populates `request.userId`, which the limiter's
    // selector reads. An unauthenticated request is answered by the first hook and never reaches
    // the second, so it consumes no token.
    { preHandler: [requireAuth, statementRateLimit] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;
      const sessionId = parseSessionId(request, reply);
      if (sessionId === null) return;

      try {
        const result = await resolveSessionStatement(sessionId, userId);
        if (!result.ok) {
          // Existence is hidden — NEVER 403. A 403 would confirm the session exists to a
          // stranger, exactly the leak `resolveSessionLens` exists to prevent.
          reply.code(404).send({ error: 'session_not_found' });
          return;
        }
        reply.code(200).send(result.statement);
      } catch (error) {
        log.error(
          {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to resolve session statement'
        );
        reply.code(503).send({ error: 'statement_unavailable' });
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
      const parsed = parseBodyOr400(finalizeDurationBodySchema, request, reply);
      if (parsed === null) return;

      try {
        const result = await finalizeExternalDuration({
          sessionId,
          minutes: parsed.minutes,
          path: parsed.path,
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
