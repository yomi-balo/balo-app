import { timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import {
  trackServer,
  CALENDAR_SERVER_EVENTS,
  toCalendarEventProvider,
} from '@balo/analytics/server';
import { buildApirocAuthorizeUrl, getApirocClient, callApiroc } from '../../lib/apiroc/index.js';
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
import { EXPERT_CALENDAR_SETTINGS_PATH } from '@balo/shared/calendar';

// ── Validation ──────────────────────────────────────────────────

const connectBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  provider: z.enum(['google', 'microsoft']),
});

/**
 * BAL-396 §10.3 — the Apiroc callback has THREE shapes and none of `error` /
 * `endUserAccountId` / `state` is guaranteed present, so every field is optional here; the
 * handler itself branches on which fields showed up (`error` FIRST, per the ordering rule).
 *
 * ⚠ BAL-397 fix round — EVERY string here is bounded. This route is PUBLIC and unauthenticated
 * (the vendor redirects a browser to it), so an unbounded `z.string()` lets anyone push
 * arbitrarily large attacker-authored text into `request.log.warn` and, through it, into paid
 * pipelines (Axiom `balo-logs`). The bounds are generous relative to the real values — a signed
 * state is ~200 chars (`base64url(payload).base64url(hmac)`), an Apiroc account id is a short
 * opaque token, and the OAuth error vocabulary is snake_case words — so nothing legitimate is
 * anywhere near them.
 */
const callbackQuerySchema = z.object({
  endUserAccountId: z.string().min(1).max(255).optional(),
  state: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(200).optional(),
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

/**
 * BAL-397 fix round — the CSRF nonce comparison, timing-safe. Hardening rather than a live
 * hole (in the modelled attack the adversary already HOLDS the nonce and needs the victim's
 * cookie, not a guess), but it makes this the third secret comparison in the codebase written
 * the same way, alongside `lib/internal-auth.ts` and `services/calendar/connect-state.ts` —
 * so no future reader has to work out why one of the three is a plain `!==`.
 *
 * The explicit length check is required: `timingSafeEqual` THROWS on unequal-length buffers.
 */
function nonceMatches(cookieNonce: string | undefined, stateNonce: string): boolean {
  if (!cookieNonce) return false;
  const provided = Buffer.from(cookieNonce);
  const expected = Buffer.from(stateNonce);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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
  // ⚠ BAL-397 fix round — `expertProfileId` is DELIBERATELY NOT read off this payload. See the
  // `trackServer` call below.
  const { provider } = state ? readStatePayloadUnverified(state) : {};
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

  // ⚠ BAL-397 fix round — `distinct_id` IS ALWAYS `'unknown'` ON THIS ARM. There is no
  // signature check on the error shape by design, so `state` here is browser-authored text:
  // forwarding its `expertProfileId` to PostHog let anyone `curl` this public route with a
  // hand-rolled state and either mint arbitrary person profiles or attribute forged
  // `OAUTH_FAILED` events to a real expert — poisoning the very funnel BAL-397's `source`
  // property was added to measure. `provider` is safe to keep because it is laundered through
  // the `toCalendarEventProvider` allowlist below; an identity has no such allowlist, so it is
  // dropped instead. The verified arms (`handleCsrfMismatch`, `persistAndRedirectConnected`)
  // still send the real id — they have `verifyConnectState`'s HMAC behind them.
  trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
    error_code: errorCode,
    ...(eventProvider ? { provider: eventProvider } : {}),
    distinct_id: 'unknown',
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
 * THE SINGLE OPAQUE REJECTION PATH for every pre-persistence SHAPE 2 failure — today the CSRF
 * nonce mismatch (BAL-396 Finding 1) and the vendor-account ownership mismatch (BAL-397 fix
 * round). Both deliberately emit the SAME wire code, `state_csrf_mismatch`.
 *
 * ⚠ DO NOT MINT A DISTINCT CODE FOR THE OWNERSHIP CHECK. The browser controls
 * `endUserAccountId`, so a code that said "that account isn't yours" (as opposed to "that
 * account doesn't exist") would turn this public, unauthenticated route into an existence
 * oracle for valid Apiroc account ids — handing an attacker exactly the enumeration primitive
 * the ownership check exists to make useless. The two causes are distinguished in the SERVER
 * LOG only (`apiroc_callback_csrf_nonce_mismatch` vs `apiroc_callback_account_binding_rejected`),
 * which no attacker can read.
 */
function rejectShape2(
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  expertProfileId: string,
  eventProvider: 'google' | 'microsoft' | undefined
): FastifyReply {
  trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
    error_code: 'state_csrf_mismatch',
    ...(eventProvider ? { provider: eventProvider } : {}),
    distinct_id: expertProfileId,
  });
  return redirectWithError(reply, ctx, 'state_csrf_mismatch', eventProvider);
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
  return rejectShape2(reply, ctx, payload.expertProfileId, eventProvider);
}

/**
 * SHAPE 2, THE VENDOR-ACCOUNT OWNERSHIP BINDING (BAL-397 fix round — closes a CRITICAL that
 * predates this ticket, from BAL-396).
 *
 * ⚠ WHY THIS EXISTS. `endUserAccountId` arrives **entirely from the browser-controlled query
 * string**, and nothing downstream re-derives it: `upsertApirocConnection` OVERWRITES the
 * pointer on the `(expertProfileId, provider)` conflict arbiter, and
 * `calendar_connections.end_user_account_id` is deliberately NON-unique, so two rows may name
 * one vendor account. Without this check an authenticated expert who learns another expert's
 * `endUserAccountId` can mint a legitimate `state` + nonce cookie for their OWN profile,
 * skip the vendor entirely, and hit the callback with the VICTIM's account id — repointing
 * their own connection at the victim's calendar. That reads the victim's free/busy into the
 * attacker's availability engine AND writes Balo's consultation events into the victim's
 * calendar. The CSRF nonce cannot catch it: it proves the browser started *a* flow, never that
 * this account came out of *that* flow.
 *
 * ⚠ THE BINDING BALO ALREADY SENDS. `buildApirocAuthorizeUrl` passes
 * `externalId: expertProfileId` on every authorize URL (`lib/apiroc/oauth.ts`), and the vendor
 * round-trips it onto the End User Account. So the account the callback names must carry the
 * SAME expert id the signed state does. Every account Balo has ever created came through that
 * one code path, so a live account with an absent/`null` `externalId` is not a legacy shape to
 * tolerate — it is an account Balo did not create, and it fails closed like any other mismatch.
 *
 * ⚠ FAIL CLOSED ON A FAILED LOOKUP TOO, not just on a mismatch. A 404 (unknown id), a 401/403,
 * a 5xx and a network timeout all land here, and every one of them means "Balo could not prove
 * this account belongs to this expert". Treating an unprovable binding as satisfied would
 * re-open the whole hole on any vendor blip.
 *
 * Wrapped in `callApiroc` per the apiroc skill's one-fallible-call rule, so the failure arrives
 * as a Balo-shaped `ApirocError` rather than the SDK's mangled one.
 */
async function endUserAccountBelongsToExpert(
  request: FastifyRequest,
  endUserAccountId: string,
  expertProfileId: string
): Promise<boolean> {
  try {
    const client = getApirocClient();
    const account = await callApiroc('endUserAccounts.get', () =>
      client.endUserAccounts.get(endUserAccountId)
    );
    return account.externalId === expertProfileId;
  } catch (err: unknown) {
    request.log.warn(
      {
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_callback_account_lookup_failed'
    );
    return false;
  }
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

    // BAL-397 §13.2 — `calendar_status` on the wire now carries the REAL vocabulary
    // (`provisionConnection` only ever returns 'ACTIVE' | 'SYNC_PENDING') so `apps/web` reads
    // it through `isCalendarCredentialStatus` rather than the retired `connected`/`sync_pending`
    // strings. `analyticsStatus` is kept as a SEPARATE local for the `trackServer` call only —
    // that PostHog property has funnel history behind it, and changing its values would fork
    // every existing funnel. Do not collapse the two back into one variable.
    const analyticsStatus = status === 'ACTIVE' ? 'connected' : 'sync_pending';
    trackServer(CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED, {
      provider,
      status: analyticsStatus,
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
      `${ctx.webAppUrl}${ctx.settingsPath}&calendar_connected=true&calendar_status=${status}` +
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
  if (!nonceMatches(cookieNonce, nonce)) {
    return handleCsrfMismatch(
      request,
      reply,
      ctx,
      { expertProfileId, provider },
      eventProvider,
      cookieNonce !== undefined
    );
  }

  // BAL-397 fix round — THE VENDOR-ACCOUNT OWNERSHIP BINDING. ⚠ MUST stay between the CSRF
  // check and `persistAndRedirectConnected`: it is the only thing that resolves the SUBJECT
  // (`endUserAccountId`, browser-supplied) against the ACTOR (`expertProfileId`, HMAC-trusted).
  // See `endUserAccountBelongsToExpert` for the full threat model.
  if (!(await endUserAccountBelongsToExpert(request, endUserAccountId, expertProfileId))) {
    request.log.warn({ expertProfileId, provider }, 'apiroc_callback_account_binding_rejected');
    return rejectShape2(reply, ctx, expertProfileId, eventProvider);
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
      settingsPath: EXPERT_CALENDAR_SETTINGS_PATH,
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
