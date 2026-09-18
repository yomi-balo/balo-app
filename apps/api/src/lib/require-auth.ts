import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@balo/shared/logging';
import {
  ACCOUNT_REFUSAL_HEADER,
  classifyAccountRefusal,
  reasonOfRefusal,
} from '@balo/shared/authz';
import { trackServer, AUTH_SERVER_EVENTS } from '@balo/analytics/server';
import { usersRepository } from '@balo/db';
import type { FastifyRequest, FastifyReply } from 'fastify';

const log = createLogger('require-auth');

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by requireAuth preHandler — Balo user UUID. */
    userId?: string;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;

  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    throw new Error('WORKOS_CLIENT_ID is not configured');
  }

  jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));
  return jwks;
}

/** The two columns liveness is decided from, plus the id every log line and event needs. */
interface ResolvedAccount {
  readonly id: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

/**
 * BAL-568 — resolve the account behind a verified `sub`. **EXACTLY ONE QUERY, ALWAYS**, backed by
 * the PARTIAL `users_workos_id_unique` — byte-identical in cost to what this route paid before the
 * ticket.
 *
 * ⚠⚠ THERE IS NO SOFT-DELETED SECOND READ, AND ITS ABSENCE IS A SECURITY DECISION (fix round 1,
 * F5). The first cut fell back to a `deleted_at IS NOT NULL` lookup when this one found nothing, so
 * the API could tell a soft-deleted account from an unknown one. That predicate CANNOT use
 * `users_workos_id_unique` — the index is partial on `WHERE deleted_at IS NULL` — so it SEQ-SCANNED
 * `users`. This function runs on the authentication hot path, BEFORE the rate limiter on every
 * route that has one, so a replayed soft-deleted token drove unthrottled full-table scans at
 * whatever rate the caller chose. Distinguishing those two cases is not worth that.
 *
 * ⚠ THE CONSEQUENCE IS DELIBERATE AND MUST NOT BE "FIXED" BY RE-ADDING THE READ:
 * `findByWorkosId` filters `deleted_at IS NULL`, so a soft-deleted account resolves to `null` here,
 * indistinguishable from an unknown `sub`. **This path can therefore only ever emit
 * `account_suspended`, never `account_deleted`.** A soft-deleted account is still fully REFUSED —
 * the only difference is that its 401 carries no teardown marker, so the web side does not
 * proactively sign it out; it stays signed in (granting nothing, every seam re-reads the row) until
 * the cookie expires or it next renders a page. The page and action paths are unaffected and still
 * emit both codes, because `findForSessionSync` does return soft-deleted rows.
 */
async function resolveAccount(sub: string): Promise<ResolvedAccount | null> {
  const live = await usersRepository.findByWorkosId(sub);
  if (live === undefined) return null;
  return { id: live.id, status: live.status, deletedAt: live.deletedAt };
}

/**
 * Fastify preHandler that validates a WorkOS Bearer token.
 * Resolves the WorkOS `sub` claim to a Balo user UUID and populates `request.userId`.
 *
 * ⚠⚠ `usersRepository` IS A STATIC ESM IMPORT AND MUST STAY ONE. It was `require('@balo/db')`
 * inline, which made EVERY `requireAuth`-gated route 401 in local dev while passing in
 * production and in CI — the worst possible asymmetry, and one no gate catches:
 *
 *   - `apps/api` is `"type": "module"`, and dev runs `tsx watch src/index.ts`, where `require`
 *     is simply not defined. The call threw a ReferenceError AFTER `jwtVerify` had already
 *     succeeded, so the catch below swallowed it as "JWT verification failed" → 401. A valid
 *     token could not pass.
 *   - Production never saw it: `tsup.config.ts` injects a `createRequire` banner into the
 *     bundle Railway runs, which defines `require`.
 *   - Unit tests never saw it either: vitest supplies its own CJS interop.
 *
 * Diagnosed from a `project_brief_parses` row stuck at `failure_reason: 'enqueue_failed'` —
 * the web action's reading of this route's 401. `no-bare-require.test.ts` now bans the shape.
 *
 * ── BAL-568 (ruling 2026-09-18): ACCOUNT LIVENESS, ON ITS OWN ARM ───────────────────────────
 *
 * ⚠⚠ THE ACCOUNT ARM SITS **OUTSIDE** THE `jwtVerify` CATCH, AND THAT IS STRUCTURAL, NOT
 * STYLISTIC. The old shape wrapped the repository read in the same `try` as the token
 * verification, so a database fault was logged as "JWT verification failed" — precisely the
 * mislabelling that disguised the `require` ReferenceError above for months. The `try` now wraps
 * `jwtVerify` and nothing else; the account read owns its own `try` and its own message.
 *
 * ⚠⚠ FAIL CLOSED ON ACCESS, FAIL OPEN ON TEARDOWN — the asymmetry is deliberate:
 *   · a CONFIRMED non-live row → 401 **with** {@link ACCOUNT_REFUSAL_HEADER}. Destructive
 *     (the web side signs the person out), correct, and attributable to a real row.
 *   · an UNREADABLE row (DB fault), an UNKNOWN `sub`, or a SOFT-DELETED one → 401 with **no**
 *     header. All three still refuse — an unreachable database must never be a way to keep acting
 *     while suspended — but none claims the account is suspended. A database blip that signed
 *     every user out with "your account has been suspended" would be a mass-logout incident AND a
 *     lie.
 *
 * ⚠⚠ THIS PATH EMITS ONLY `account_suspended`, NEVER `account_deleted` (fix round 1, F5). A
 * soft-deleted account is invisible to `findByWorkosId` and so lands on the unmarked unknown-`sub`
 * arm. That is the accepted cost of not seq-scanning `users` ahead of the rate limiter — see
 * {@link resolveAccount} for the full reasoning. It is a TEARDOWN difference, not an access one:
 * the account is refused either way.
 *
 * ⚠ THE 401 BODY IS BYTE-IDENTICAL ON EVERY ARM (`{"error":"Unauthorized"}`). The marker is a
 * response HEADER, which is what reconciles the ticket's "byte-identical 401" with the ruling's
 * "explicit, non-guessable marker" — see {@link ACCOUNT_REFUSAL_HEADER}'s docblock for why that
 * discloses nothing about a third party.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const token = header.slice(7);

  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(token, getJwks());
    sub = payload.sub;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'JWT verification failed'
    );
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  if (sub === undefined || sub.length === 0) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  let account: ResolvedAccount | null;
  try {
    account = await resolveAccount(sub);
  } catch (error) {
    // Fail closed on ACCESS; emit NO marker — this is a teardown-neutral refusal.
    log.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Account liveness read failed — refusing'
    );
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  if (account === null) {
    // ⚠ Byte-identical to the pre-BAL-568 line, and deliberately UNMARKED: an unknown `sub` is
    // not an account-state refusal and must not be enumerable as one.
    log.warn({ workosId: sub }, 'No Balo user found for WorkOS ID');
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const refusal = classifyAccountRefusal(account);
  if (refusal !== null) {
    const reason = reasonOfRefusal(refusal);
    // ⚠ THE BALO USER ID AND THE STATUS ONLY. Never the token, never `sub`, never the email.
    log.warn(
      {
        userId: account.id,
        status: account.status,
        deleted: account.deletedAt !== null,
        reason,
      },
      'Account not live — refusing API call'
    );
    trackServer(AUTH_SERVER_EVENTS.SESSION_INVALIDATED, {
      distinct_id: account.id,
      path: 'api',
      reason,
    });
    return reply
      .status(401)
      .header(ACCOUNT_REFUSAL_HEADER, refusal)
      .send({ error: 'Unauthorized' });
  }

  request.userId = account.id;
}
