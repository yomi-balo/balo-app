/**
 * BAL-132 — the meeting JOIN surface, registered inside the existing `meetingsRoutes` plugin.
 *
 * ⚠⚠ TWO OF THESE THREE ROUTES ARE **PUBLIC**, AND THEY ARE THE FIRST UNAUTHENTICATED ROUTES
 * ON `/meetings/*`. That is not an oversight to be "fixed" by a helpful `requireAuth`:
 *
 *   · `POST /meetings/:meetingId/lobby`      — an anonymous visitor at a bare meeting URL
 *     knocks. They have no account BY DEFINITION; that is what the admission queue is for.
 *   · `POST /meetings/:meetingId/guest-join` — a guest presents a ≥256-bit token. The TOKEN
 *     is the credential; a guest has no WorkOS session to send a Bearer from.
 *
 * `join.test.ts` asserts that neither answers `401` without a Bearer, precisely so that
 * adding the preHandler breaks a test instead of breaking the product.
 *
 * ⚠ THIS FILE IS THE `log.warn` BOUNDARY. Every mapped branch logs server-side and sends only
 * a fixed literal — the logging lives INSIDE `sendJoinError`, so "every mapped branch logs"
 * is structurally true rather than a convention maintained by hand. Same shape as
 * `sendGuestError`.
 *
 * ⚠⚠ THERE IS NO `403` ANYWHERE ON THIS SURFACE, AND `meeting_not_found` IS DELIBERATELY
 * OVERLOADED. It collapses: no such meeting; soft-deleted; unresolvable or ambiguous context;
 * an admin-only meeting; not your party; no capability; an unknown, expired, revoked or
 * DENIED guest token; a token whose meeting disagrees with the URL; and — on the anonymous
 * lobby arm ONLY — a cancelled or ended meeting and a full room. Which shape it was goes to
 * the LOG as a distinct `reason`; NEVER to the wire.
 *
 * ⚠⚠ AND NO RESPONSE EVER ECHOES `err.message`. `DailyApiError` carries the vendor's raw body
 * and the requested room name, which is a pure function of `meetings.id` — i.e. a raw uuid.
 * The wire value is `meeting_token_unavailable`; the error goes to `log.error` inside the
 * service and nowhere else. The Zod-details echo pattern in `route-helpers.ts` is for Zod
 * issues ONLY, which describe the caller's own input.
 */
import { isIP } from 'node:net';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { withDeadline } from '../../lib/with-deadline.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import {
  claimLobbyPlace,
  joinMeetingAsGuest,
  joinMeetingAsMember,
  type JoinErrorCode,
} from '../../services/meetings/join-meeting.js';
import { guestJoinBodySchema, lobbyClaimBodySchema, meetingIdParamsSchema } from './join.schema.js';

const log = createLogger('meeting-join-route');

/**
 * Service literal → HTTP status. Exhaustive over `JoinErrorCode` BY TYPE, so a new literal is
 * a compile error here rather than a silent `undefined` status (i.e. a 500).
 *
 * `meeting_token_unavailable` is `503`, not `502` or `500`: the vendor (or our own
 * configuration) is down, the caller's request was perfectly valid, and a retry in a moment
 * is the correct advice. A `500` would additionally invite Sentry noise for an upstream
 * outage we already log deliberately.
 */
const JOIN_ERROR_STATUS: Record<JoinErrorCode, number> = {
  meeting_not_found: 404,
  meeting_not_open_for_join: 409,
  meeting_not_provisioned: 409,
  meeting_token_unavailable: 503,
};

/**
 * PRODUCT NUMBERS, not physical limits — same status as `INVITE_MEETING_RATE_LIMIT`, and a
 * natural early migration when `platform_config` (BAL-398) lands.
 *
 * ⚠⚠ READ {@link visitorIdentity} BEFORE CHANGING ANY OF THESE. The KEY each window is
 * measured on matters more than the number on it, and the first cut of this file got the key
 * wrong in a way that made the tight windows fire on legitimate traffic.
 */

/**
 * ONE ANONYMOUS VISITOR's knocks. Keyed on `peer|client` — see {@link visitorIdentity}.
 *
 * 10/hour is generous for every legitimate pattern (a mistyped address, a colleague
 * re-knocking) and makes a single actor an ineffective source of queue noise.
 */
const LOBBY_VISITOR_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-lobby:visitor',
  maxRequests: 10,
  windowSeconds: 3600,
};

/**
 * ONE VISITOR against ONE meeting.
 *
 * ⚠⚠ KEYED ON `meetingId|client`, NOT ON `meetingId` ALONE, AND THAT CHANGE IS THE WHOLE
 * FINDING. A bare `meetingId` key is an AVAILABILITY LEVER POINTED AT THE HOST: anyone who
 * knows (or guesses) a meeting id could burn its 20 knocks in seconds and lock out every
 * legitimate guest for the following hour. The mitigation was strictly worse than the attack
 * it mitigated.
 *
 * ⚠ THE THING THE OLD WINDOW WAS FOR — "do not let somebody fill the admit/deny panel with
 * noise" — IS NOW A CAP, NOT A RATE. `MAX_LOBBY_QUEUE` bounds the queue's SIZE directly
 * (`claimLobbyPlace`), which is both the property that actually matters and one a host can
 * clear: an admit, a deny, a revoke or an expiry each free a slot. A rate limit could only
 * ever delay a flood; a cap refuses one, and it cannot be aimed at anybody.
 */
const LOBBY_MEETING_VISITOR_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-lobby:meeting-visitor',
  maxRequests: 20,
  windowSeconds: 3600,
};

/**
 * THE ABSOLUTE BACKSTOP ON THE LOBBY, keyed on the UNSPOOFABLE peer alone.
 *
 * ⚠ THE ONLY WINDOW A HEADER-SPOOFING CALLER CANNOT ESCAPE. `x-balo-client-ip` is a CLAIM
 * (see {@link visitorIdentity}); a caller reaching this route directly can rotate it freely
 * and thereby get a fresh bucket in both windows above. They cannot rotate `request.ip`,
 * which Fastify derives from `trustProxy: 1`.
 *
 * ⚠ SO IT IS SIZED FOR THE **WEB TIER**, WHICH IS THE LEGITIMATE PEER FOR EVERY REAL VISITOR
 * — all lobby traffic arrives via `apps/web`'s Server Action, so this bounds the whole
 * platform's knock volume per web egress address, not one person's.
 */
const LOBBY_PEER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-lobby:peer',
  maxRequests: 600,
  windowSeconds: 3600,
};

/**
 * ONE WAITING GUEST's polls. Keyed on `peer|client`.
 *
 * ⚠⚠ THE KEY IS WHY THIS NUMBER IS SURVIVABLE. Keyed on the PEER alone — which is what a
 * `request.ip` read gives you when every request arrives from `apps/web`'s Server Action —
 * all guests on the platform would share ONE bucket, and at the documented poll cadence
 * (~264 requests/hour each) THREE concurrent waiting guests would exceed 600 on their own.
 * That is a functional break at trivial load, not merely a weak control.
 *
 * ⚠ DELIBERATELY GENEROUS PER VISITOR: this endpoint is POLLED every 5 seconds by a guest
 * sitting in the lobby (720/hour at that rate would exceed it, which is why the client backs
 * off to 15s after two minutes — 600 covers a ~35-minute wait with headroom). It exists to
 * bound SCANNING, not to bound waiting.
 */
const GUEST_JOIN_VISITOR_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guest-join:visitor',
  maxRequests: 600,
  windowSeconds: 3600,
};

/**
 * THE ABSOLUTE BACKSTOP ON THE POLL, keyed on the unspoofable peer alone. Same role as
 * {@link LOBBY_PEER_RATE_LIMIT}.
 *
 * ⚠ SIZED FOR AGGREGATE LEGITIMATE LOAD THROUGH ONE WEB EGRESS ADDRESS, so it is large: at
 * ~264 requests/hour per waiting guest, 20 000 supports ~75 concurrent lobby guests behind a
 * single egress IP. It is a blast-radius bound, NOT a per-visitor one — do not read it as a
 * scanning control, because scanning this route without a ≥256-bit token learns nothing
 * (every outcome is `meeting_not_found`).
 */
const GUEST_JOIN_PEER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guest-join:peer',
  maxRequests: 20_000,
  windowSeconds: 3600,
};

/**
 * ⚠ THE HEADER `apps/web` USES TO FORWARD THE ORIGINAL VISITOR'S ADDRESS.
 *
 * Deliberately NOT `X-Forwarded-For`: appending to that header would need `trustProxy` raised
 * to 2 app-wide, which would change how EVERY other route resolves `request.ip` — including
 * routes whose limits are load-bearing today.
 */
const CLIENT_IP_HEADER = 'x-balo-client-ip';

/**
 * Send a service failure as its fixed literal.
 *
 * ⚠ THE `log.warn` LIVES HERE, NOT AT THE CALL SITES. ⚠ `context` MUST NEVER CARRY AN EMAIL
 * ADDRESS, A RAW TOKEN OR A DAILY JWT — ids, counts and route labels only.
 */
function sendJoinError(
  reply: FastifyReply,
  code: JoinErrorCode,
  context: Record<string, unknown>
): void {
  const status = JOIN_ERROR_STATUS[code];
  log.warn({ ...context, code, status }, 'Meeting join refused');
  reply.code(status).send({ error: code });
}

/** Validate `:meetingId` or send `400 invalid_request`. `null` ⇒ the reply is already sent. */
function parseMeetingParams(params: unknown, reply: FastifyReply): { meetingId: string } | null {
  const parsed = meetingIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  return parsed.data;
}

/**
 * Consume one token from each supplied window. Returns `true` when the reply has ALREADY been
 * sent and the caller must return immediately.
 *
 * ⚠ FAILS CLOSED — a Redis outage answers `503`, never "carry on unlimited". These are the
 * only PUBLIC write/probe surfaces in the app; an unmetered window during an outage is the
 * exact failure the limiter exists to prevent. (`routes/experts/search.ts` fails OPEN on a
 * read and documents why; do not copy that decision here.)
 *
 * ⚠⚠ AND `withDeadline` IS WHAT MAKES THAT TRUE RATHER THAN MERELY INTENDED. `getRedis()`
 * sets `maxRetriesPerRequest: null` (BullMQ requires it), so ioredis parks commands in its
 * offline queue instead of failing them — without the deadline the `catch` below is
 * UNREACHABLE during the very outage it exists for, and the request simply hangs until an
 * upstream proxy kills it. See `with-deadline.ts`.
 */
async function enforceRateLimits(
  reply: FastifyReply,
  route: string,
  windows: ReadonlyArray<{ config: RateLimitConfig; identifier: string; kind: string }>
): Promise<boolean> {
  for (const { config, identifier, kind } of windows) {
    try {
      const result = await withDeadline(() => checkRateLimit(getRedis(), config, identifier), {
        deadlineMs: RATE_LIMIT_DEADLINE_MS,
        label: `rate limit ${config.keyPrefix}`,
      });
      if (result.allowed) continue;
      log.warn({ route, keyPrefix: config.keyPrefix, kind }, 'Meeting join rate-limited');
      reply
        .header('Retry-After', String(result.ttlSeconds))
        .code(429)
        .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
      return true;
    } catch (error) {
      log.error(
        {
          route,
          keyPrefix: config.keyPrefix,
          kind,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Meeting join rate-limit unavailable — failing CLOSED'
      );
      reply.code(503).send({ error: 'rate_limit_unavailable' });
      return true;
    }
  }
  return false;
}

/**
 * WHO IS ASKING — as two values with two DIFFERENT trust levels. ⚠⚠ READ THIS BEFORE ADDING
 * OR RE-KEYING ANY WINDOW ON THIS FILE.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────
 *
 * `request.ip` is the PEER, and for these two routes the peer is essentially never the
 * visitor. Every real lobby request arrives as a server-to-server `fetch` from `apps/web`'s
 * Server Action, so `request.ip` is the WEB TIER's egress address, identical for every guest
 * on the planet. Keyed on that, the "per-IP" windows were one platform-wide bucket: at the
 * documented poll cadence three concurrent waiting guests exceeded the 600/hour window on
 * their own. So the visitor's own address has to be forwarded.
 *
 * ── THE TRUST BOUNDARY WE RELY ON, NAMED ────────────────────────────────────────────────
 *
 *   · `peer` — `request.ip`, via Fastify's `trustProxy: 1`: the LAST hop of `X-Forwarded-For`,
 *     written by the Railway edge. **UNSPOOFABLE by the caller** (an attacker-supplied entry
 *     sits earlier in the list and is never read). This is the only trustworthy value here.
 *   · `client` — the `x-balo-client-ip` header. **A CLAIM, NOT A FACT.** It is trustworthy
 *     exactly insofar as (a) it was written by `apps/web`, which reads it from a header the
 *     HOSTING PLATFORM sets and the browser cannot override (`x-vercel-forwarded-for`, then
 *     `x-real-ip`, then the LAST — platform-appended — entry of `X-Forwarded-For`; see
 *     `resolveVisitorIp` in `apps/web`), and (b) this route is reached through that web tier.
 *     Neither is enforced here, because it CANNOT be: the two lobby routes are public by
 *     design and deliberately do NOT carry `INTERNAL_API_SECRET`, so there is nothing to
 *     authenticate the header with.
 *
 * ── WHAT THAT COSTS, AND WHAT IT DOES NOT ───────────────────────────────────────────────
 *
 * A caller who reaches this route DIRECTLY can put anything in the header. Two consequences,
 * both bounded on purpose — ⚠ BUT BY TWO DIFFERENT MECHANISMS, AND CONFLATING THEM IS HOW A
 * FUTURE EDIT GOES WRONG:
 *
 *   · EVASION — they can rotate the claim and get a fresh per-visitor bucket each time.
 *     Bounded by `LOBBY_PEER_RATE_LIMIT` / `GUEST_JOIN_PEER_RATE_LIMIT`, which are keyed on
 *     `peer` ALONE and which no header can move.
 *   · FRAMING — burning some victim's window. **THE COMPOSITE KEY BOUNDS A *BYPASSING*
 *     CALLER, AND ONLY THAT ONE.** A legitimate visitor's bucket is
 *     `<web-tier-egress>|<their-ip>`; an attacker calling this route directly has a different
 *     `peer`, so every key they can construct is disjoint from every key a real visitor uses.
 *     That is why the per-visitor keys are COMPOSITE `peer|client` rather than bare `client`.
 *
 *     ⚠⚠ IT DOES **NOT** BOUND A CALLER WHO GOES *THROUGH* `apps/web`. Their `peer` IS the
 *     shared web egress, exactly like a real visitor's, so `<egress>|<victim-ip>` is a
 *     constructible key. What bounds THAT caller is entirely on the other side of the hop:
 *     the HEADER-SELECTION ORDER in `resolveVisitorIp` (`apps/web`), which reads
 *     `x-vercel-forwarded-for` FIRST — a header Vercel strips from client requests on ingress
 *     — and only falls through to `x-real-ip` / the last `x-forwarded-for` entry when it is
 *     absent. On the shipped topology branch 1 always wins, so a browser cannot choose the
 *     value; on a bare `next start` behind a naive proxy it could. **An earlier version of
 *     this note called framing "structurally prevented" full stop. It is not — read the two
 *     bullets as two separate arguments, and do not weaken either believing the other covers
 *     it.**
 *
 * ⚠ A COMPOSITE KEY IS **LOOSER** WHEN THE WEB TIER HAS SEVERAL EGRESS ADDRESSES — one
 * visitor's budget splits across them. That is the right direction to err: a looser spam bound
 * never refuses a legitimate guest, whereas the alternative (bare `client`) trades a
 * cross-tenant DoS for tidiness.
 *
 * ⚠ THE CLAIM IS VALIDATED AS AN IP AND OTHERWISE DROPPED. `net.isIP` is an exact, linear
 * check — no regex, so no S5852 exposure — and it stops arbitrary caller-controlled bytes
 * becoming Redis key material.
 */
interface VisitorIdentity {
  /** ⚠ UNSPOOFABLE. `request.ip` under `trustProxy: 1`. */
  readonly peer: string;
  /** ⚠ THE PER-VISITOR RATE-LIMIT KEY: `peer|client`. Never `client` alone. */
  readonly visitorKey: string;
}

function visitorIdentity(request: FastifyRequest): VisitorIdentity {
  const peer = request.ip;
  const claimed = request.headers[CLIENT_IP_HEADER];
  const client = typeof claimed === 'string' && isIP(claimed) !== 0 ? claimed : peer;
  return { peer, visitorKey: `${peer}|${client}` };
}

export async function meetingJoinRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /meetings/:meetingId/join — the MEMBER arm. AUTHENTICATED.
   *
   * `200` with `roomUrl`, `token`, `isOwner`, `expiresAt` (ISO) and `participantId`.
   *
   * ⚠ NOT RATE-LIMITED, matching the shipped surface where only the mail-emitting invite
   * route is. The caller is already authenticated and already proven to belong to this
   * meeting; the only thing a limit would bound is a member re-joining their own call, which
   * is exactly what the generous token window exists to allow.
   */
  fastify.post('/meetings/:meetingId/join', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (userId === null) return;

    const params = parseMeetingParams(req.params, reply);
    if (params === null) return;

    const result = await joinMeetingAsMember({ meetingId: params.meetingId, userId });
    if (!result.ok) {
      sendJoinError(reply, result.code, { route: 'join', meetingId: params.meetingId, userId });
      return;
    }
    // ⚠ BAL-435 (R6 / R10): the grant's five fields stay at the TOP LEVEL, byte for byte, and
    // the meeting's context — plus the waiting stage's inputs — ride ALONGSIDE them. `JoinGrant`
    // itself is unchanged, so an older client that knows nothing about these is unaffected, and
    // the two PUBLIC guest arms below deliberately carry none of them.
    reply.code(200).send({
      ...result.grant,
      context: result.context,
      viewerRole: result.viewerRole,
      counterpartyFirstName: result.counterpartyFirstName,
      scheduledStart: result.scheduledStart,
    });
  });

  /**
   * POST /meetings/:meetingId/lobby — the ANONYMOUS self-claim. ⚠ PUBLIC, NO `requireAuth`.
   *
   * `201` with `state: "waiting"` and `lobbyToken` (the 43-char base64url raw token).
   *
   * ⚠ THE RAW TOKEN IN THE RESPONSE DOES NOT BREACH BAL-408'S "THE RAW TOKEN NEVER COMES
   * BACK" CONTRACT. That forbids returning an INVITE token to a HOST's UI so it can build a
   * link for somebody else; this token was minted FOR the bearer and is returned ONLY to the
   * bearer, on the connection that created it. See `claimLobbyPlace`'s docblock.
   *
   * ⚠ VALIDATION FIRST, THEN THE LIMITER, THEN THE SERVICE — so a malformed body cannot
   * consume somebody's window, and a refused request costs no database work.
   */
  fastify.post('/meetings/:meetingId/lobby', async (req, reply) => {
    const params = parseMeetingParams(req.params, reply);
    if (params === null) return;

    const body = parseBodyOr400(lobbyClaimBodySchema, req, reply);
    if (body === null) return;

    // ⚠ PER-VISITOR WINDOWS FIRST, THE PEER BACKSTOP LAST — so an abuser is told about their
    // OWN limit (and gets its `Retry-After`) rather than about the platform-wide one, which
    // would leak how much aggregate headroom is left.
    const { peer, visitorKey } = visitorIdentity(req);
    const limited = await enforceRateLimits(reply, 'lobby', [
      { config: LOBBY_VISITOR_RATE_LIMIT, identifier: visitorKey, kind: 'visitor' },
      {
        config: LOBBY_MEETING_VISITOR_RATE_LIMIT,
        identifier: `${params.meetingId}|${visitorKey}`,
        kind: 'meeting-visitor',
      },
      { config: LOBBY_PEER_RATE_LIMIT, identifier: peer, kind: 'peer' },
    ]);
    if (limited) return;

    const result = await claimLobbyPlace({
      meetingId: params.meetingId,
      name: body.name,
      email: body.email,
    });
    if (!result.ok) {
      // ⚠ NO EMAIL ADDRESS IN THIS CONTEXT — the meeting id is the safe, useful field.
      sendJoinError(reply, result.code, { route: 'lobby', meetingId: params.meetingId });
      return;
    }
    reply.code(201).send({ state: 'waiting', lobbyToken: result.lobbyToken });
  });

  /**
   * POST /meetings/:meetingId/guest-join — the guest MINT / POLL. ⚠ PUBLIC, NO `requireAuth`.
   *
   * Always `200` on success, with a discriminated `state`:
   *   · `admitted` + `grant` — a `pre_admitted` invitee (mints on the FIRST call, so there is
   *     no visible token step) or a lobby visitor a host has now admitted;
   *   · `waiting`  — still `pending`. ⚠ NO GRANT, and nothing was minted, tracked or written.
   *
   * ⚠ A DENIED TOKEN NEVER GETS ITS OWN STATE. `findLiveByTokenHash` filters `denied` out
   * entirely, so it resolves to `undefined` → `meeting_not_found` → the client's generic
   * "this link isn't active" card. That is the correct privacy answer and it is free.
   *
   * ⚠ A POST FOR WHAT IS ARGUABLY A READ, ON PURPOSE: the token must travel in the BODY, not
   * in a URL that lands in access logs and `Referer` headers.
   */
  fastify.post('/meetings/:meetingId/guest-join', async (req, reply) => {
    const params = parseMeetingParams(req.params, reply);
    if (params === null) return;

    const body = parseBodyOr400(guestJoinBodySchema, req, reply);
    if (body === null) return;

    const { peer, visitorKey } = visitorIdentity(req);
    const limited = await enforceRateLimits(reply, 'guest-join', [
      { config: GUEST_JOIN_VISITOR_RATE_LIMIT, identifier: visitorKey, kind: 'visitor' },
      { config: GUEST_JOIN_PEER_RATE_LIMIT, identifier: peer, kind: 'peer' },
    ]);
    if (limited) return;

    const result = await joinMeetingAsGuest({
      meetingId: params.meetingId,
      rawGuestToken: body.guestToken,
    });
    if (!result.ok) {
      // ⚠ NO TOKEN, NOT EVEN A PREFIX, IN THE ROUTE LOG — the service already logged a hash
      // prefix where one is useful, and this context reaches a different log line.
      sendJoinError(reply, result.code, { route: 'guest-join', meetingId: params.meetingId });
      return;
    }
    if (result.state === 'waiting') {
      reply.code(200).send({ state: 'waiting' });
      return;
    }
    reply.code(200).send({ state: 'admitted', grant: result.grant });
  });

  log.info('Registered meeting join routes');
}
