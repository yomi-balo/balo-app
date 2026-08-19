import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import {
  trackServer,
  CALENDAR_SERVER_EVENTS,
  toCalendarEventProvider,
} from '@balo/analytics/server';
import { buildApirocAuthorizeUrl } from '../../lib/apiroc/index.js';
import {
  signConnectState,
  verifyConnectState,
  readStatePayloadUnverified,
  extractCookieValue,
  buildClearConnectNonceCookieHeader,
  buildClearAllConnectNonceCookieHeaders,
  calendarConnectNonceCookieName,
  calendarConnectCookieDomain,
} from '../../services/calendar/connect-state.js';
import {
  persistApirocConnection,
  provisionConnection,
} from '../../services/calendar/apiroc-connection.js';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { enqueueSubscriptionReconcile } from '../../jobs/calendar-subscription-reconcile.js';

// ── Validation ──────────────────────────────────────────────────

const connectBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  provider: z.enum(['google', 'microsoft']),
});

/**
 * BAL-396 §10.3 — the Apiroc callback has THREE shapes and none of `error` /
 * `endUserAccountId` / `state` is guaranteed present, so every field is optional here; the
 * handler itself branches on which fields showed up (`error` FIRST, per the ordering rule).
 */
const callbackQuerySchema = z.object({
  endUserAccountId: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

// ── §10.3 — the callback error classifier (Objection 8) ─────────

/**
 * ⚠ THE APIROC CALLBACK ERROR VOCABULARY IS ONLY PARTLY KNOWN. The BAL-393 spike observed
 * exactly ONE callback value — `missing_required_permissions` (apiroc skill, "OAuth connect &
 * callback") — and never probed a Microsoft admin-consent denial. `access_denied`,
 * `consent_required` and `admin_approval` are Microsoft/AAD OAuth vocabulary carried over from
 * the Cronofy handler; they are PLAUSIBLE (Apiroc proxies the provider's OAuth error) and
 * UNVERIFIED.
 *
 * So: match defensively over BOTH `error` and `error_description`, keep every legacy marker,
 * and LOG anything unmatched under a named marker so the real vocabulary is learned from
 * production instead of guessed at again.
 */
const O365_ADMIN_MARKERS = ['access_denied', 'consent_required', 'admin_approval'] as const;
const PARTIAL_GRANT_MARKERS = ['missing_required_permissions'] as const;

export function classifyCallbackError(error: string, description?: string): string {
  const haystack = `${error} ${description ?? ''}`.toLowerCase();
  if (PARTIAL_GRANT_MARKERS.some((m) => haystack.includes(m))) return 'partial_grant';
  if (O365_ADMIN_MARKERS.some((m) => haystack.includes(m))) return 'o365_admin_approval';
  return 'callback_failed';
}

// ── Callback helpers (BAL-396 fix round 2 — extracted out of the route handler to keep its
// cognitive complexity under the SonarCloud gate; the three-shape branching plus the added
// per-provider cookie logic pushed the single-function version well past it) ────────────────

interface CallbackRedirectContext {
  readonly webAppUrl: string;
  readonly settingsPath: string;
  readonly clearCookieHostname: string | undefined;
}

/** Clears the CSRF-binding cookie — the specific provider's slot when known, every provider's
 *  slot otherwise. The single call site for the ternary every callback shape used to repeat
 *  (BAL-396 fix round 2, Finding 5). */
function clearConnectNonceCookie(
  reply: FastifyReply,
  hostname: string | undefined,
  eventProvider: 'google' | 'microsoft' | undefined
): void {
  reply.header(
    'set-cookie',
    eventProvider
      ? buildClearConnectNonceCookieHeader(hostname, eventProvider)
      : buildClearAllConnectNonceCookieHeaders(hostname)
  );
}

function redirectWithError(
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  errorCode: string,
  eventProvider?: 'google' | 'microsoft'
): FastifyReply {
  const providerParam = eventProvider
    ? `&calendar_provider=${encodeURIComponent(eventProvider)}`
    : '';
  return reply.redirect(
    `${ctx.webAppUrl}${ctx.settingsPath}&calendar_error=${errorCode}${providerParam}`
  );
}

/**
 * SHAPE 1 — `error` present. The caller branches on this FIRST (was BAL-456) so a partial
 * grant never reaches persistence.
 */
function handleCallbackErrorShape(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  fields: { error: string; errorDescription?: string; state?: string }
): FastifyReply {
  const { error, errorDescription, state } = fields;
  const { expertProfileId, provider } = state ? readStatePayloadUnverified(state) : {};
  const errorCode = classifyCallbackError(error, errorDescription);

  if (errorCode === 'callback_failed') {
    request.log.warn({ error, errorDescription }, 'apiroc_callback_error_unclassified');
  }

  // BAL-396 fix round, Finding 2 — `provider` here comes from the UNVERIFIED state (the
  // signature may be expired or tampered), so it is never trustworthy as raw text for a
  // redirect `Location` header. `toCalendarEventProvider` is the allowlist Balo already has
  // for exactly this ('google' | 'microsoft' | undefined) — reuse it as the redirect gate too.
  const eventProvider = provider ? toCalendarEventProvider(provider) : undefined;

  // BAL-396 fix round 2, Finding 5 — clear the SPECIFIC provider's cookie when the unverified
  // state names one; a forged `provider` here only clears a cookie that is not the real
  // in-flight one, never a security-relevant miss. Falls back to clearing every provider's
  // cookie when the state is absent or names nothing recognisable.
  clearConnectNonceCookie(reply, ctx.clearCookieHostname, eventProvider);

  trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
    error_code: errorCode,
    ...(eventProvider ? { provider: eventProvider } : {}),
    distinct_id: expertProfileId ?? 'unknown',
  });

  return redirectWithError(reply, ctx, errorCode, eventProvider);
}

/**
 * SHAPE 2, `state` verification failure. `state`'s `provider` is untrustworthy here too, so
 * this falls back to the same UNVERIFIED best-effort extraction Shape 1 uses, for the same
 * reason.
 */
function handleInvalidState(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  state: string,
  err: unknown
): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  const errorCode = message.includes('expired') ? 'state_expired' : 'invalid_state';
  request.log.warn({ error: message }, 'apiroc_callback_state_invalid');

  const { provider: unverifiedProvider } = readStatePayloadUnverified(state);
  const eventProvider = unverifiedProvider
    ? toCalendarEventProvider(unverifiedProvider)
    : undefined;
  clearConnectNonceCookie(reply, ctx.clearCookieHostname, eventProvider);

  return redirectWithError(reply, ctx, errorCode);
}

/**
 * SHAPE 2, the CSRF binding check itself (BAL-396 fix round, Finding 1). `state`'s HMAC
 * proves Balo minted it for `expertProfileId`; it does NOT prove this browser is the one that
 * started the flow. Missing or mismatched → reject via the existing error-redirect path,
 * never a 500, and persist nothing.
 */
function handleCsrfMismatch(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  payload: { expertProfileId: string; provider: string },
  eventProvider: 'google' | 'microsoft' | undefined,
  hasCookie: boolean
): FastifyReply {
  request.log.warn(
    { expertProfileId: payload.expertProfileId, provider: payload.provider, hasCookie },
    'apiroc_callback_csrf_nonce_mismatch'
  );
  trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
    error_code: 'state_csrf_mismatch',
    ...(eventProvider ? { provider: eventProvider } : {}),
    distinct_id: payload.expertProfileId,
  });
  return redirectWithError(reply, ctx, 'state_csrf_mismatch', eventProvider);
}

/**
 * SHAPE 2 happy path — persist, provision, rebuild availability, redirect connected. A
 * post-persistence failure still redirects (never a 500): the connection row already exists,
 * so a retry from this same response would fail the CSRF check instead of proceeding cleanly.
 */
async function persistAndRedirectConnected(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  payload: { expertProfileId: string; provider: string; endUserAccountId: string }
): Promise<FastifyReply> {
  const { expertProfileId, provider, endUserAccountId } = payload;
  try {
    const connection = await persistApirocConnection({
      expertProfileId,
      provider,
      endUserAccountId,
    });
    const status = await provisionConnection(connection);
    await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);
    // BAL-468 §8.4/§8.6 — covers both first connect (force is a no-op — nothing to renew) and
    // reconnect (force re-creates every canonical subscription rather than trusting a vendor
    // channel that may have died silently during the revoke). Only on ACTIVE: a SYNC_PENDING
    // connection has no sub-calendars yet, so there is nothing to subscribe.
    if (status === 'ACTIVE') {
      await enqueueSubscriptionReconcile(connection.id, { force: true }, request.log);
    }

    // `provisionConnection` only ever returns 'ACTIVE' | 'SYNC_PENDING' — a plain ternary is
    // exhaustive here without pulling in `api.ts`'s 4-value adapter.
    const legacyStatus = status === 'ACTIVE' ? 'connected' : 'sync_pending';
    trackServer(CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED, {
      provider,
      status: legacyStatus,
      distinct_id: expertProfileId,
    });

    // BAL-396 fix round, Finding 4 — `calendar_provider` MUST ride along on the success
    // redirect too, not just the error ones. A SYNC_PENDING connection has zero sub-calendars
    // by construction, so `apps/web` cannot recover the provider from the connection payload;
    // without this param it silently falls back to the client's hardcoded 'google' default,
    // and "Fix permissions" for a stuck Microsoft expert then starts a GOOGLE OAuth round trip
    // instead. `provider` is trusted here (it came out of `verifyConnectState`, itself only
    // ever signed from the `z.enum(['google', 'microsoft'])`-validated connect body) —
    // `encodeURIComponent` is defense in depth, not a trust boundary.
    return reply.redirect(
      `${ctx.webAppUrl}${ctx.settingsPath}&calendar_connected=true&calendar_status=${legacyStatus}` +
        `&calendar_provider=${encodeURIComponent(provider)}`
    );
  } catch (err: unknown) {
    request.log.error(
      {
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Apiroc OAuth callback failed after account creation'
    );

    const eventProvider = toCalendarEventProvider(provider);
    trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
      error_code: 'callback_failed',
      ...(eventProvider ? { provider: eventProvider } : {}),
      distinct_id: expertProfileId,
    });

    return reply.redirect(
      `${ctx.webAppUrl}${ctx.settingsPath}&calendar_error=callback_failed` +
        `&calendar_provider=${encodeURIComponent(provider)}`
    );
  }
}

/** SHAPE 2 — `endUserAccountId` + `state` present. */
async function handleEndUserAccountIdShape(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  fields: { endUserAccountId: string; state: string }
): Promise<FastifyReply> {
  const { endUserAccountId, state } = fields;

  let statePayload: { expertProfileId: string; provider: string; nonce: string };
  try {
    statePayload = verifyConnectState(state);
  } catch (err: unknown) {
    return handleInvalidState(request, reply, ctx, state, err);
  }

  const { expertProfileId, provider, nonce } = statePayload;
  // `state` verified — HMAC-trusted — so `provider` is trustworthy here, unlike the unverified
  // arms above. Still narrowed through the same allowlist rather than assumed, since the DB
  // column backing it is a bare `text` with no CHECK (api.ts's `mapProvider` carries the
  // identical defensive-narrowing note).
  const eventProvider = toCalendarEventProvider(provider);

  // BAL-396 fix round 2, Finding 5 — clear THIS provider's cookie now that `state` is trusted.
  // `eventProvider` should always be defined post-BAL-396 (the connect body is
  // `z.enum(['google', 'microsoft'])`-validated before a state is ever signed), but a signed
  // state minted before some future provider removal is not impossible — fall back to
  // clearing every slot rather than assuming.
  clearConnectNonceCookie(reply, ctx.clearCookieHostname, eventProvider);

  // BAL-396 fix round, Finding 1 — THE CSRF BINDING CHECK.
  const cookieNonce = eventProvider
    ? extractCookieValue(request.headers.cookie, calendarConnectNonceCookieName(eventProvider))
    : undefined;
  if (!cookieNonce || cookieNonce !== nonce) {
    return handleCsrfMismatch(
      request,
      reply,
      ctx,
      { expertProfileId, provider },
      eventProvider,
      cookieNonce !== undefined
    );
  }

  return persistAndRedirectConnected(request, reply, ctx, {
    expertProfileId,
    provider,
    endUserAccountId,
  });
}

// ── Routes ──────────────────────────────────────────────────────

export async function calendarAuthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/calendar/connect
   * Builds the Apiroc hosted-OAuth authorize URL and returns it.
   * Protected by requireInternalAuth — called from server actions, not directly from browser.
   */
  fastify.post(
    '/api/calendar/connect',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = connectBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, provider } = parsed.data;

      try {
        const state = signConnectState(expertProfileId, provider);
        // BAL-396 fix round, Finding 1 — hand the nonce back so apps/web (which owns the
        // browser-facing request/response cycle) can bind it to a short-lived cookie. Cheap:
        // `verifyConnectState` on a state we just signed ourselves, never expired, never
        // tampered — just an extraction, not a trust boundary.
        const { nonce } = verifyConnectState(state);
        const authUrl = buildApirocAuthorizeUrl({ provider, state, externalId: expertProfileId });
        return reply.send({ authUrl, nonce });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            provider,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to generate Apiroc auth URL'
        );
        return reply.status(500).send({ error: 'Failed to initiate calendar connection' });
      }
    }
  );

  /**
   * GET /auth/apiroc/callback (public — the vendor redirects the browser here)
   *
   * ⚠ BRANCH ON `error` FIRST (was BAL-456). A partial grant must NEVER create a
   * `calendar_connections` row — persisting anything before checking `error` risks exactly
   * that on a handler that assumes the happy shape.
   */
  fastify.get('/auth/apiroc/callback', async (request, reply) => {
    // ⚠ NOT WEB_APP_URL (BAL-396 §16) — that variable is undocumented and unset in
    // production; APP_URL is the one every other user-facing link already uses.
    const ctx: CallbackRedirectContext = {
      webAppUrl: process.env.APP_URL ?? 'http://localhost:3000',
      settingsPath: '/expert/settings?tab=calendar',
      // BAL-396 fix round 2, Finding 1 — `Domain` now comes from the ONE shared derivation
      // (`@balo/shared/calendar`, re-exported by `connect-state.js`) that apps/web's
      // cookie-set also calls, so the two sides cannot disagree the way the hand-duplicated
      // versions did.
      clearCookieHostname: calendarConnectCookieDomain(),
    };

    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      request.log.warn('Invalid Apiroc OAuth callback query params');
      // BAL-396 fix round 2, Finding 5 — the cookie is now scoped PER PROVIDER, and a
      // malformed callback carries no `state` to learn one from, so clear every provider's
      // slot. Over-clearing a cookie the browser never set is a no-op.
      clearConnectNonceCookie(reply, ctx.clearCookieHostname, undefined);
      return reply.redirect(`${ctx.webAppUrl}${ctx.settingsPath}&calendar_error=invalid_callback`);
    }

    const { endUserAccountId, state, error, error_description: errorDescription } = parsed.data;

    // ── SHAPE 1: `error` present ─────────────────────────────────
    if (error) {
      return handleCallbackErrorShape(request, reply, ctx, { error, errorDescription, state });
    }

    // ── SHAPE 2: `endUserAccountId` present ──────────────────────
    if (endUserAccountId && state) {
      return handleEndUserAccountIdShape(request, reply, ctx, { endUserAccountId, state });
    }

    // ── SHAPE 3: neither — must not crash ────────────────────────
    request.log.warn('Apiroc OAuth callback received neither error nor endUserAccountId');
    // No trustworthy provider signal in this shape either — clear every provider's cookie.
    clearConnectNonceCookie(reply, ctx.clearCookieHostname, undefined);
    return reply.redirect(`${ctx.webAppUrl}${ctx.settingsPath}&calendar_error=invalid_callback`);
  });
}
