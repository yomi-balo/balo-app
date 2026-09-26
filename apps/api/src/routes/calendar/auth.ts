import { timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { calendarRepository } from '@balo/db';
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
import { reconcileExpertSearchability } from '../../services/experts/searchability.js';
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
 * THE SINGLE OPAQUE REJECTION PATH for every pre-OWNERSHIP SHAPE 2 failure — today the CSRF
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
 *
 * ⚠ BAL-575's `account_mismatch` is a DELIBERATELY DISTINCT code, not a third case of this
 * function. It is only ever emitted AFTER ownership has already passed — by then the account is
 * proven to carry this expert's own `externalId`, so naming the reconnect refusal costs an
 * attacker nothing. Moving that refusal earlier, or folding it into this opaque path, would
 * reopen exactly the existence oracle this function exists to close.
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
 * string**, and nothing downstream re-derives it. Without this check an authenticated expert
 * who learns another expert's `endUserAccountId` can mint a legitimate `state` + nonce cookie
 * for their OWN profile, skip the vendor entirely, and hit the callback with the VICTIM's
 * account id — repointing their own connection at the victim's calendar. That reads the
 * victim's free/busy into the attacker's availability engine AND writes Balo's consultation
 * events into the victim's calendar. The CSRF nonce cannot catch it: it proves the browser
 * started *a* flow, never that this account came out of *that* flow.
 *
 * ⚠ `upsertApirocConnection` REFUSES a different End User Account against a live row (see that
 * method's docblock) — it no longer overwrites the pointer. This check still has to run first
 * regardless: it guards the INSERT arm (a brand-new row would otherwise happily persist a
 * victim's account) and the same-EUA UPDATE arm (an attacker replaying their own
 * already-connected EUA still needs to fail here, not rely on the repository refusing it).
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
 *
 * BAL-575 — this stays the SINGLE `endUserAccounts.get` call on the happy path; no second
 * lookup is added anywhere downstream. On a match, the returned `email` (trimmed; empty, `null`,
 * or absent all become `null` — the SDK's `string` type is not trusted blindly, see the read
 * below) rides along so the caller can persist it and pass it on as `loginHint` on a future
 * connect — the ownership check already paid for this vendor round trip.
 */
async function resolveOwnedEndUserAccount(
  request: FastifyRequest,
  endUserAccountId: string,
  expertProfileId: string
): Promise<{ owned: false } | { owned: true; email: string | null }> {
  try {
    const client = getApirocClient();
    const account = await callApiroc('endUserAccounts.get', () =>
      client.endUserAccounts.get(endUserAccountId)
    );
    if (account.externalId !== expertProfileId) {
      return { owned: false };
    }
    // BAL-575 — the SDK types `email` as `string`, but that is a type claim about the wire
    // shape, not a guarantee; an absent or `null` value here must not throw inside this try
    // and get mistaken for a lookup failure (which the catch below reports as `owned: false`
    // and logs misleadingly). Guard the read instead of trusting the type.
    const raw = typeof account.email === 'string' ? account.email.trim() : '';
    return { owned: true, email: raw.length > 0 ? raw : null };
  } catch (err: unknown) {
    request.log.warn(
      {
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_callback_account_lookup_failed'
    );
    return { owned: false };
  }
}

/**
 * BAL-414 (D3.1, §C #3) — re-list on OAuth reconnect. Extracted to a module-level helper (fix
 * round 1, BLOCKER 2) purely to keep `persistAndRedirectConnected`'s cognitive complexity under
 * the SonarCloud gate — behaviour is unchanged. Wrapped in its OWN try/catch, separate from the
 * caller's: a reconcile failure here must not misreport an otherwise-successful OAuth connect as
 * `calendar_error=callback_failed` — log and continue, matching the route's documented
 * "post-persistence failure still redirects" contract. The read path and the next probe tick
 * both reconcile.
 */
async function reconcileAfterConnect(
  expertProfileId: string,
  provider: string,
  request: FastifyRequest
): Promise<void> {
  try {
    await reconcileExpertSearchability({
      expertProfileId,
      source: 'calendar_connected',
      actorUserId: null,
      publishNotification: true,
    });
  } catch (reconcileErr: unknown) {
    request.log.error(
      {
        expertProfileId,
        provider,
        error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
        stack: reconcileErr instanceof Error ? reconcileErr.stack : undefined,
      },
      'searchability_reconcile_failed'
    );
  }
}

/**
 * BAL-575 — the connect route's stored-connection read, extracted so a rejection can
 * degrade to no hint instead of sharing the route's try with state signing and the URL build. A
 * prefill, never a guard: on a rejection the connect proceeds with no hint rather than failing.
 */
async function resolveConnectLoginHint(
  request: FastifyRequest,
  expertProfileId: string,
  provider: string
): Promise<string | undefined> {
  try {
    const existingConnection = await calendarRepository.findConnectionByExpertAndProvider(
      expertProfileId,
      provider
    );
    return existingConnection?.providerEmail ?? undefined;
  } catch (err: unknown) {
    request.log.warn(
      {
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_connect_login_hint_lookup_failed'
    );
    return undefined;
  }
}

/**
 * BAL-575 — best-effort vendor cleanup of an End User Account the callback JUST refused
 * to persist. NEVER THROWS: it runs after the refusal is already final and redirect-worthy, so
 * a cleanup failure must not turn a clean `account_mismatch` redirect into `callback_failed`
 * and fire a second `OAUTH_FAILED` (apiroc skill, `connect-and-credentials.md` §3.2, step 5).
 *
 * ⚠ ONLY THE CALLBACK'S OWNERSHIP-VERIFIED, JUST-REFUSED id is ever passed in — never the
 * stored/live pointer a connection already points at, and never an id that failed the
 * ownership check (that arm never reaches this function at all). `findConnectionsByEndUserAccountId`
 * is the live-reference guard: `cal_conn_end_user_account_idx` is deliberately non-unique, so
 * another expert's connection may legitimately share this vendor account, and deleting it out
 * from under that row would be worse than leaving an orphaned one. No subscription cleanup is
 * needed here — a refused account never got a Balo `calendar_connections` row, so it never got
 * Balo-created subscriptions either. The live-reference rule is shared with `disconnectProvider`
 * through that one repository read; nothing is excluded here because the refused account never
 * got a Balo row of its own.
 */
async function discardRefusedEndUserAccount(
  request: FastifyRequest,
  endUserAccountId: string,
  expertProfileId: string,
  provider: string
): Promise<void> {
  try {
    const referencing = await calendarRepository.findConnectionsByEndUserAccountId(
      endUserAccountId,
      { excludingConnectionId: null }
    );
    if (referencing.length > 0) {
      request.log.info(
        { expertProfileId, provider, referencingConnections: referencing.length },
        'apiroc_callback_refused_account_retained'
      );
      return;
    }

    const client = getApirocClient();
    await callApiroc('endUserAccounts.delete', () =>
      client.endUserAccounts.delete(endUserAccountId)
    );
  } catch (err: unknown) {
    request.log.warn(
      {
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
      },
      'apiroc_callback_refused_account_delete_failed'
    );
  }
}

/**
 * BAL-575 — the reconnect-with-a-different-account refusal redirect. Kept as its own
 * module-level helper (not inlined into `persistAndRedirectConnected`) purely to keep that
 * function's cognitive complexity under the SonarCloud gate.
 *
 * No email in this log line, by design — only ids and the provider, matching every other warn
 * on this file's SHAPE 2 path.
 */
async function rejectAccountMismatch(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  payload: { expertProfileId: string; provider: string; endUserAccountId: string }
): Promise<FastifyReply> {
  const { expertProfileId, provider, endUserAccountId } = payload;
  request.log.warn({ expertProfileId, provider }, 'apiroc_callback_reconnect_account_mismatch');

  const eventProvider = toCalendarEventProvider(provider);
  trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
    error_code: 'account_mismatch',
    ...(eventProvider ? { provider: eventProvider } : {}),
    distinct_id: expertProfileId,
  });

  await discardRefusedEndUserAccount(request, endUserAccountId, expertProfileId, provider);

  return redirectWithError(reply, ctx, 'account_mismatch', eventProvider);
}

/**
 * SHAPE 2 happy path — persist, provision, rebuild availability, redirect connected. A
 * post-persistence failure still redirects (never a 500): the connection row already exists,
 * so a retry from this same response would fail the CSRF check instead of proceeding cleanly.
 *
 * BAL-575 — `persistApirocConnection` can also come back `refused_account_mismatch` (a live row
 * already points this (expert, provider) at a DIFFERENT End User Account). That arm returns
 * immediately via `rejectAccountMismatch`, before `provisionConnection` or anything else below
 * runs — nothing downstream may act on a connection the repository just refused to touch.
 * Everything from here down reads `result.connection`, the persisted row.
 */
async function persistAndRedirectConnected(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CallbackRedirectContext,
  payload: {
    expertProfileId: string;
    provider: string;
    endUserAccountId: string;
    providerEmail: string | null;
  }
): Promise<FastifyReply> {
  const { expertProfileId, provider, endUserAccountId, providerEmail } = payload;
  try {
    const result = await persistApirocConnection({
      expertProfileId,
      provider,
      endUserAccountId,
      providerEmail,
    });

    if (result.outcome === 'refused_account_mismatch') {
      return await rejectAccountMismatch(request, reply, ctx, {
        expertProfileId,
        provider,
        endUserAccountId,
      });
    }

    if (result.providerEmailChanged) {
      // BAL-575 — same End User Account, a different email than Balo last stored. A DB
      // refusal cannot restore an account swap the vendor already made behind this id; this is
      // a signal for BAL-577, not an error to act on here. No email in the log line.
      request.log.warn(
        {
          expertProfileId,
          provider,
          connectionId: result.connection.id,
          providerEmailChanged: true,
        },
        'apiroc_callback_provider_email_changed'
      );
    }

    const connection = result.connection;
    const status = await provisionConnection(connection);
    await enqueueAvailabilityCacheRebuild(expertProfileId, request.log);
    // BAL-468 §8.4/§8.6 — covers both first connect (force is a no-op — nothing to renew) and
    // reconnect (force re-creates every canonical subscription rather than trusting a vendor
    // channel that may have died silently during the revoke). Only on ACTIVE: a SYNC_PENDING
    // connection has no sub-calendars yet, so there is nothing to subscribe.
    if (status === 'ACTIVE') {
      await enqueueSubscriptionReconcile(connection.id, { force: true }, request.log);
      await reconcileAfterConnect(expertProfileId, provider, request);
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
  // See `resolveOwnedEndUserAccount` for the full threat model.
  const ownership = await resolveOwnedEndUserAccount(request, endUserAccountId, expertProfileId);
  if (!ownership.owned) {
    request.log.warn({ expertProfileId, provider }, 'apiroc_callback_account_binding_rejected');
    return rejectShape2(reply, ctx, expertProfileId, eventProvider);
  }

  return persistAndRedirectConnected(request, reply, ctx, {
    expertProfileId,
    provider,
    endUserAccountId,
    providerEmail: ownership.email,
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

      // BAL-575 — prefill the vendor's login/account-chooser with the email this (expert,
      // provider) is already connected under, when one is known. A SEPARATE, non-fatal read,
      // kept OUTSIDE the try below: a failed lookup degrades to no hint instead of producing a
      // 500 that would block Add calendar, Reconnect and Fix permissions alike.
      const loginHint = await resolveConnectLoginHint(request, expertProfileId, provider);

      try {
        const state = signConnectState(expertProfileId, provider);
        // BAL-396 fix round, Finding 1 — hand the nonce back so apps/web (which owns the
        // browser-facing request/response cycle) can bind it to a short-lived cookie. Cheap:
        // `verifyConnectState` on a state we just signed ourselves, never expired, never
        // tampered — just an extraction, not a trust boundary.
        const { nonce } = verifyConnectState(state);
        const authUrl = buildApirocAuthorizeUrl({
          provider,
          state,
          externalId: expertProfileId,
          ...(loginHint ? { loginHint } : {}),
        });
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
