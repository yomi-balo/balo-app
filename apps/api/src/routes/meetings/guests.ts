/**
 * BAL-408 / ADR-1044 — the guest participation HTTP surface, registered inside the existing
 * `meetingsRoutes` plugin.
 *
 * ⚠ THIS IS THE DELIVERABLE. None of BAL-400 / BAL-421 / BAL-132 exists yet (verified:
 * `booking-card.tsx`'s `onBook` is an analytics-only stub, there is no `/cases` route in web
 * or api, and `@daily-co/daily-js` is not a dependency of any package). So the "one invite
 * seam consumed by all three entry points" ships here as a PUBLISHED CONTRACT: a stable HTTP
 * API those three tickets call WITHOUT MODIFYING IT. Each adds one thin client module
 * (`apps/web/src/lib/meetings/guests-api-client.ts`, copying `lib/credit/api-client.ts`'s
 * `callSessionApi` — the viewer's WorkOS access token forwarded as `Authorization: Bearer`,
 * resolved server-side from the iron-session) and calls these five operations.
 *
 * ⚠ THE WHOLE SURFACE SHIPS INERT — no UI calls it. That is the same posture `POST /meetings`
 * itself is in, and it is why the tests here matter more than usual: they are the only
 * consumer until BAL-400 lands.
 *
 * ── WHAT CALLERS MUST NOT RE-IMPLEMENT ──────────────────────────────────────────
 *   1. NEVER send `party` — the server derives it from the actor's resolved side. A UI that
 *      guessed would be a cross-party write.
 *   2. NEVER send `accessScope` — the server computes and stores it. To render the scope
 *      badge BEFORE sending, call `classifyEmailDomain` / `extractEmailDomain`
 *      (`@balo/shared/domains`) plus the company's live domains as a PREVIEW; the server's
 *      value is authoritative.
 *   3. `entryPoint` is REQUIRED and is the only field that differs between the three surfaces.
 *   4. THE RAW TOKEN NEVER COMES BACK. UIs do not build join links; the engine emails them.
 *   5. Render "{n} of 10" from `participantCount` / `participantCap`, never a local count.
 *      ⚠ `participantCount` IS THE **SEAT** COUNT — the reserved pair plus guests who are
 *      `pre_admitted` or `admitted` and not expired — and it is produced by the very counter
 *      the server refuses invites on, so the number a UI shows and the number that decides a
 *      `participant_cap_reached` cannot disagree. It deliberately EXCLUDES waiting knocks:
 *      queue depth is a different resource with a different cap (`MAX_LOBBY_QUEUE`), and it
 *      is answered by counting `guests[].admission === 'pending'` — the projection omits
 *      fields across the party boundary, never rows.
 *   6. BAL-132 gates its admit/deny CONTROLS on `canHost` from the GET response — NOT on
 *      `lens === 'expert'`, which is the comparison ADR-1029 forbids and which the in-meeting
 *      design prototype does ("take the layout; do not take its gate"). Shipping `canHost`
 *      here is what means BAL-132 needs no new endpoint.
 *   7. Errors are FIXED LITERALS. Map them to copy; never surface `err.message`.
 *
 * ── THIS FILE IS THE `log.error` BOUNDARY ───────────────────────────────────────
 * Every mapped branch logs server-side and sends only a fixed literal — the logging lives in
 * `sendGuestError` itself, so a new branch cannot be added without one. ⚠ NEVER echo a
 * service error message and NEVER log a guest's email address or a raw token.
 *
 * ⚠ THERE IS NO `403` ANYWHERE ON THIS SURFACE. `meeting_not_found` collapses "no such
 * meeting", "not your party", "unresolvable/ambiguous context" and "not a host"; and
 * `guest_not_found` collapses "no such guest" and "that guest belongs to the other party".
 * See `authorize-meeting-participation.ts` for the full oracle argument.
 *
 * ── ⚠⚠ THE INVITE ROUTE IS AN EMAIL-EMISSION PRIMITIVE, AND IT IS RATE-LIMITED ────
 * `POST /guests` sends mail FROM BALO'S SENDING DOMAIN TO ANY ADDRESS THE ACTOR NAMES, and
 * the naive bounds do not hold it: the `(meeting, party, email)` unique is PARTIAL, and
 * `revoke` sets `revoked_at` AND `deleted_at`, so invite → remove → invite is an unbounded
 * loop; BullMQ jobId dedup never bites either, because a fresh `meeting_guests.id` is minted
 * per cycle (and `removeOnComplete: { count: 100 }` means a retained-job collision is not a
 * guarantee anyway). The bound is therefore the Redis fixed window below — the
 * `POST /meetings` precedent, including its FAIL-CLOSED posture.
 */
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
  decideGuestAdmission,
  inviteGuests,
  listGuests,
  removeGuest,
  resendGuestJoinLink,
  type GuestServiceErrorCode,
} from '../../services/meetings/guest-participation.js';
import {
  inviteGuestsBodySchema,
  meetingGuestParamsSchema,
  meetingIdParamsSchema,
} from './guests.schema.js';

const log = createLogger('meeting-guests-route');

/**
 * PRODUCT NUMBERS, not physical limits — the same status as `BOOKING_USER_RATE_LIMIT` in
 * `routes/meetings/index.ts`, and a natural early migration when `platform_config`
 * (BAL-398) lands.
 *
 * TWO WINDOWS, and the tighter one is the point. A meeting caps at
 * `MAX_MEETING_PARTICIPANTS` (10) live guests, so a legitimate composer needs at most a
 * couple of requests per meeting — 6 gives room for a mistyped address and a re-invite
 * after a removal, while capping one meeting's invite→remove→invite loop at 6 cycles an
 * hour. The per-actor window then bounds the same actor sweeping many meetings.
 */
const INVITE_MEETING_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guests:user-meeting',
  maxRequests: 6,
  windowSeconds: 3600,
};

const INVITE_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guests:user',
  maxRequests: 30,
  windowSeconds: 3600,
};

/**
 * BAL-436 — the RE-SEND windows. ⚠ IT IS AN EMAIL-EMISSION PRIMITIVE TOO, aimed at an address
 * AN ANONYMOUS VISITOR TYPED, so it inherits the invite route's posture exactly: windows
 * checked before the service, failing CLOSED on a Redis outage.
 *
 * ── ⚠⚠ THREE WINDOWS, AND THE THIRD IS NOT SYMMETRY — IT IS THE ONE THAT MATCHES THE
 *      RESOURCE BEING PROTECTED ───────────────────────────────────────────────────────────
 *
 * The protected resource is **one external address's inbox**, and a second protected thing
 * rides along with it: each rotation KILLS the previous credential, so a re-send aimed at a
 * stranded guest is also a way to keep that guest stranded.
 *
 * The `${userId}:${guestId}` window bounds ONE ACTOR against one row. It does not bound the
 * ROW: an agency with k admins who may all host this meeting yields **3k emails an hour** to
 * an unverified address, each one invalidating the link the previous one sent — a griefing
 * vector against exactly the person the affordance exists to rescue, and a mail-reputation
 * exposure keyed on a stranger's typed address.
 *
 * So the third window is keyed on `guestId` ALONE. It is deliberately looser than the
 * per-actor one (5, not 3) so that two hosts genuinely helping the same person are not
 * refused, while the absolute ceiling on one inbox stops being a function of headcount.
 *
 * TIGHTER THAN THE INVITE'S, deliberately. A re-send targets ONE existing row, so a
 * legitimate host needs it once — twice if the first genuinely did not arrive. The per-actor
 * window then bounds a host sweeping many rows or many meetings.
 *
 * ⚠ PRODUCT NUMBERS, NOT PHYSICAL LIMITS — same status as the invite's, and a natural early
 * migration when `platform_config` (BAL-398) lands. ⚠ That PR is NOT merged; typed consts today.
 */
const RESEND_GUEST_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guests:resend-guest',
  maxRequests: 3,
  windowSeconds: 3600,
};

/**
 * ⚠⚠ KEYED ON THE GUEST ROW ALONE — the ONLY window that is not a function of how many hosts
 * the meeting has. See the block above: without it, k admins × 3 = 3k emails an hour to one
 * unverified inbox, each rotation killing the previous credential.
 */
const RESEND_ROW_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guests:resend-row',
  maxRequests: 5,
  windowSeconds: 3600,
};

const RESEND_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-guests:resend-user',
  maxRequests: 10,
  windowSeconds: 3600,
};

/**
 * Service literal → HTTP status. Exhaustive over `GuestServiceErrorCode` by type, so a new
 * literal cannot ship without a status decision here.
 *
 * `delegate_must_be_client_side` is `422`, not `400`: the body was well-FORMED (Zod passed)
 * and the request is semantically impossible for THIS actor — which is exactly what 422 is
 * for, and it keeps the Zod-failure literal meaning only "malformed".
 */
const GUEST_ERROR_STATUS: Record<GuestServiceErrorCode, number> = {
  meeting_not_found: 404,
  guest_not_found: 404,
  meeting_not_open_for_guests: 409,
  participant_cap_reached: 409,
  guest_already_invited: 409,
  guest_not_pending: 409,
  // BAL-436 — `409`, not `404`: the row EXISTS and the actor may host it, so this is a
  // conflict with the row's current state (wrong channel, or not yet admitted), which is
  // exactly what 409 means. It confirms nothing to anyone who was not already entitled to
  // read this roster — it is reachable strictly AFTER both gates.
  guest_link_not_resendable: 409,
  delegate_must_be_client_side: 422,
};

/**
 * Send a service failure as its fixed literal. Never derived from an error message.
 *
 * ⚠ THE `log.warn` LIVES HERE, NOT AT THE CALL SITES, so the module docblock's "every mapped
 * branch logs server-side" is structurally true rather than a claim maintained by hand. The
 * refusals this covers — `guest_already_invited`, `delegate_must_be_client_side`,
 * `guest_not_pending`, `participant_cap_reached` — are the ones a caller reports as "it just
 * says no"; without a line each, the only server-side evidence would be the absence of a
 * subsequent success.
 *
 * ⚠ `context` MUST NEVER CARRY AN EMAIL ADDRESS OR A TOKEN. Ids and counts only.
 */
function sendGuestError(
  reply: FastifyReply,
  code: GuestServiceErrorCode,
  context: Record<string, unknown>
): void {
  const status = GUEST_ERROR_STATUS[code];
  log.warn({ ...context, code, status }, 'Guest request refused');
  reply.code(status).send({ error: code });
}

/**
 * Consume one token from each invite window. Returns `true` when the reply has ALREADY been
 * sent and the caller must return immediately.
 *
 * ⚠ FAILS CLOSED — a Redis outage answers `503`, never "carry on unlimited". This route
 * emits mail to arbitrary third-party addresses; an unmetered window during an outage is the
 * exact failure this limiter exists to prevent. `routes/experts/search.ts` fails OPEN on a
 * READ and documents why; do not copy that decision onto a send path.
 *
 * ⚠⚠ AND THE DEADLINE IS WHAT MAKES THAT TRUE RATHER THAN MERELY INTENDED. Without
 * `withDeadline` the `catch` below is UNREACHABLE during the outage it exists for:
 * `maxRetriesPerRequest: null` (required by BullMQ) means ioredis never fails pending
 * commands, and the offline queue parks them instead — so `checkRateLimit` simply never
 * settles, no `503` is ever sent, and the request hangs on a Fastify connection until an
 * upstream proxy kills it. The bound converts that hang into the refusal this docblock
 * always claimed. See `with-deadline.ts` for the verified ioredis mechanism.
 */
async function enforceRateLimitWindows(
  windows: ReadonlyArray<{ config: RateLimitConfig; identifier: string }>,
  context: Record<string, unknown>,
  reply: FastifyReply
): Promise<boolean> {
  for (const { config, identifier } of windows) {
    try {
      const result = await withDeadline(() => checkRateLimit(getRedis(), config, identifier), {
        deadlineMs: RATE_LIMIT_DEADLINE_MS,
        label: `rate limit ${config.keyPrefix}`,
      });
      if (result.allowed) continue;
      log.warn({ ...context, keyPrefix: config.keyPrefix }, 'Guest email emission rate-limited');
      reply
        .header('Retry-After', String(result.ttlSeconds))
        .code(429)
        .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
      return true;
    } catch (error) {
      log.error(
        {
          ...context,
          keyPrefix: config.keyPrefix,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Guest email emission rate-limit unavailable — failing CLOSED'
      );
      reply.code(503).send({ error: 'rate_limit_unavailable' });
      return true;
    }
  }
  return false;
}

/** The INVITE windows: per (actor, meeting), then per actor. See the config docblocks. */
async function enforceInviteRateLimit(
  userId: string,
  meetingId: string,
  reply: FastifyReply
): Promise<boolean> {
  return enforceRateLimitWindows(
    [
      { config: INVITE_MEETING_RATE_LIMIT, identifier: `${userId}:${meetingId}` },
      { config: INVITE_USER_RATE_LIMIT, identifier: userId },
    ],
    { route: 'invite', userId, meetingId },
    reply
  );
}

/**
 * BAL-436 — the RE-SEND windows: per (actor, GUEST ROW), then per GUEST ROW, then per actor.
 *
 * ⚠ THE TIGHT WINDOW IS KEYED ON THE **GUEST ROW**, NOT THE MEETING, and that is the whole
 * point of it: the resource being protected is one external address's inbox, and a host with
 * several stranded guests on one call must still be able to help each of them. Keying on the
 * meeting would let three re-sends to ONE address exhaust the window for everybody else on
 * the call, while doing nothing to stop three addresses being mailed three times each.
 *
 * ⚠⚠ THE **SECOND** WINDOW DROPS THE ACTOR, AND THAT IS THE ONE THAT ACTUALLY BOUNDS THE
 * INBOX. `${userId}:${guestId}` bounds one actor against one row; an agency of k hosts
 * multiplies it by k. Since every rotation also KILLS the previous credential, that is a
 * griefing vector against the stranded guest, not merely mail volume. Keyed on the row alone,
 * the ceiling stops being a function of headcount. ⚠ ORDERED BEFORE the per-actor window so a
 * host who has personally sent nothing is still told about the bound they actually hit.
 */
async function enforceResendRateLimit(
  userId: string,
  guestId: string,
  meetingId: string,
  reply: FastifyReply
): Promise<boolean> {
  return enforceRateLimitWindows(
    [
      { config: RESEND_GUEST_RATE_LIMIT, identifier: `${userId}:${guestId}` },
      { config: RESEND_ROW_RATE_LIMIT, identifier: guestId },
      { config: RESEND_USER_RATE_LIMIT, identifier: userId },
    ],
    { route: 'resend', userId, meetingId, guestId },
    reply
  );
}

/**
 * Validate `:meetingId` (and optionally `:guestId`) or send `400 invalid_request`.
 * Returns `null` when the reply has ALREADY been sent and the caller must return.
 *
 * ⚠ Zod messages here carry no server-side uuid (the params are the caller's own input), so
 * echoing nothing but the literal is safe and house style.
 */
function parseMeetingParams(params: unknown, reply: FastifyReply): { meetingId: string } | null {
  const parsed = meetingIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  return parsed.data;
}

function parseGuestParams(
  params: unknown,
  reply: FastifyReply
): { meetingId: string; guestId: string } | null {
  const parsed = meetingGuestParamsSchema.safeParse(params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  return parsed.data;
}

export async function meetingGuestRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /meetings/:meetingId/guests — invite one or more guests.
   *
   * `201` with the created rows, plus the roster counts AFTER the writes so the composer can
   * re-render "{n} of 10" without a second call.
   * ⚠ `token_hash` is never in a response, and the RAW token never reaches the caller — it
   * goes only into the notification payload. The three UI entry points do not need it.
   *
   * ⚠ RATE-LIMITED, AND ORDERED AFTER VALIDATION BUT BEFORE THE SERVICE. Validation first so
   * a malformed body cannot consume somebody's window; the limiter before `inviteGuests` so
   * a refused request costs no database work and, crucially, emits no mail. See the module
   * docblock for why the ordinary bounds do not hold this route.
   */
  fastify.post('/meetings/:meetingId/guests', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (userId === null) return;

    const params = parseMeetingParams(req.params, reply);
    if (params === null) return;

    const body = parseBodyOr400(inviteGuestsBodySchema, req, reply);
    if (body === null) return;

    if (await enforceInviteRateLimit(userId, params.meetingId, reply)) return;

    try {
      const result = await inviteGuests({
        meetingId: params.meetingId,
        actorUserId: userId,
        entryPoint: body.entryPoint,
        guests: body.guests,
      });
      if (!result.ok) {
        sendGuestError(reply, result.code, {
          route: 'invite',
          meetingId: params.meetingId,
          userId,
          guestCount: body.guests.length,
        });
        return;
      }
      reply.code(201).send({
        guests: result.guests,
        participantCount: result.participantCount,
        participantCap: result.participantCap,
      });
    } catch (error) {
      // ⚠ NO EMAIL ADDRESSES IN THIS LOG — the guest count is the useful, safe field.
      log.error(
        {
          meetingId: params.meetingId,
          userId,
          guestCount: body.guests.length,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Guest invite failed'
      );
      throw error;
    }
  });

  /**
   * GET /meetings/:meetingId/guests — the PARTY-SCOPED roster.
   *
   * ⚠ Every row has passed through `projectGuestForViewer`: names cross the party boundary,
   * email addresses NEVER, and cross-party fields are OMITTED rather than nulled.
   * ⚠ `canHost` is computed with `hasEngagementCapability(HOST_MEETINGS)` — see contract
   * point 6 in the module docblock.
   * ⚠ NO meeting-state check: an ENDED meeting's roster stays readable (it is the record of
   * who was on the call), while inviting to one does not. That asymmetry is deliberate and
   * pinned by tests.
   */
  fastify.get('/meetings/:meetingId/guests', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (userId === null) return;

    const params = parseMeetingParams(req.params, reply);
    if (params === null) return;

    const result = await listGuests({ meetingId: params.meetingId, actorUserId: userId });
    if (!result.ok) {
      sendGuestError(reply, result.code, { route: 'list', meetingId: params.meetingId, userId });
      return;
    }
    reply.code(200).send({
      guests: result.guests,
      canHost: result.canHost,
      participantCount: result.participantCount,
      participantCap: result.participantCap,
    });
  });

  /**
   * DELETE /meetings/:meetingId/guests/:guestId — revoke a guest's access.
   *
   * `204`. Revocation is IMMEDIATE AND TOTAL (`revoked_at` + `deleted_at` in one transaction
   * + an audit row); every read path re-checks `revoked_at IS NULL`, so a link already in an
   * inbox stops resolving on the next click. The person is emailed, and only that person.
   *
   * ⚠ SAME-PARTY RULE: an actor may remove only a guest on their own side. A cross-party
   * attempt answers `404 guest_not_found`, identical on the wire to a non-existent id.
   *
   * ⚠ NO `meeting_not_open_for_guests` ON THIS ROUTE — the ONLY guest mutation with no
   * meeting-state check. The join token deliberately keeps resolving for
   * `GUEST_TOKEN_TTL_AFTER_END_MS` (7 days) after a meeting `ended`, so gating removal on
   * the terminal set would leave a live credential — still rendering the inviter, the
   * counterparty org and the other guests' names — with no way to switch it off for a week.
   * A credential must stay revocable for at least as long as it is valid. See
   * `removeGuest`'s docblock.
   */
  fastify.delete(
    '/meetings/:meetingId/guests/:guestId',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (userId === null) return;

      const params = parseGuestParams(req.params, reply);
      if (params === null) return;

      try {
        const result = await removeGuest({
          meetingId: params.meetingId,
          guestId: params.guestId,
          actorUserId: userId,
        });
        if (!result.ok) {
          sendGuestError(reply, result.code, {
            route: 'remove',
            meetingId: params.meetingId,
            guestId: params.guestId,
            userId,
          });
          return;
        }
        reply.code(204).send();
      } catch (error) {
        log.error(
          {
            meetingId: params.meetingId,
            guestId: params.guestId,
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Guest removal failed'
        );
        throw error;
      }
    }
  );

  /**
   * POST /meetings/:meetingId/guests/:guestId/admit  and  …/deny
   *
   * ⚠⚠ **LIVE AS OF BAL-132.** These shipped inert because nothing produced an
   * `admission = 'pending'` row, so every call answered `409 guest_not_pending`. BAL-132 IS
   * that ticket: the anonymous lobby (`POST /meetings/:meetingId/lobby`) now produces pending
   * rows, so both routes are genuinely reachable and `409` is now the RACE answer.
   *
   * ⚠ ONLY THE HOST'S **UI** IS OUTSTANDING — BAL-436 owns the admit/deny panel, and carries
   * the obligation this route cannot: a `link`-channel pending row's name and email are
   * SELF-DECLARED by an anonymous visitor, so the panel must mark them UNVERIFIED and must
   * never present the address as identity.
   *
   * ⚠ TWO GATES, IN ORDER: tenancy (`authorizeMeetingParticipation`) THEN delivery identity
   * (`hasEngagementCapability(HOST_MEETINGS)`). The second does not subsume the first — see
   * that seam's "NOTHING IN THIS FILE AUTHORIZES THE READ" block.
   *
   * ⚠ NEITHER PUBLISHES A NOTIFICATION. The person is in the lobby watching the UI: an email
   * after a DENY is hostile, after an ADMIT redundant.
   *
   * The two routes are registered from ONE data-driven loop rather than copy-pasted: they
   * differ by a single literal, and two hand-written 30-line handlers would be duplicated
   * source for no benefit.
   */
  const ADMISSION_ROUTES = [
    { suffix: 'admit', decision: 'admitted' },
    { suffix: 'deny', decision: 'denied' },
  ] as const;

  for (const { suffix, decision } of ADMISSION_ROUTES) {
    fastify.post(
      `/meetings/:meetingId/guests/:guestId/${suffix}`,
      { preHandler: [requireAuth] },
      async (req, reply) => {
        const userId = resolveUserId(req, reply);
        if (userId === null) return;

        const params = parseGuestParams(req.params, reply);
        if (params === null) return;

        try {
          const result = await decideGuestAdmission({
            meetingId: params.meetingId,
            guestId: params.guestId,
            actorUserId: userId,
            decision,
          });
          if (!result.ok) {
            sendGuestError(reply, result.code, {
              route: 'admission',
              meetingId: params.meetingId,
              guestId: params.guestId,
              userId,
              decision,
            });
            return;
          }
          reply
            .code(200)
            .send({ id: result.id, admission: result.admission, decidedAt: result.decidedAt });
        } catch (error) {
          log.error(
            {
              meetingId: params.meetingId,
              guestId: params.guestId,
              userId,
              decision,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            'Guest admission decision failed'
          );
          throw error;
        }
      }
    );
  }

  /**
   * BAL-436 — POST /meetings/:meetingId/guests/:guestId/resend-link
   *
   * Re-issue a stranded guest's join credential. `200 { id, expiresAt }`.
   *
   * ⚠⚠ **THE RAW TOKEN IS NEVER IN THE RESPONSE.** It goes into the notification payload and
   * nowhere else — contract point 4: UIs do not build join links, the engine emails them.
   *
   * ⚠ ROTATION KILLS THE PREVIOUS CREDENTIAL. That is deliberate: the host is re-sending
   * because the old one is believed lost, and two live credentials on one row is a second
   * hijack surface. `resendGuestJoinLink`'s docblock carries the full argument, and BAL-442's
   * guest self-service arm must call THAT function rather than mint a second rotation path.
   *
   * ⚠ TWO GATES, IN ORDER: tenancy (`authorizeMeetingParticipation`) THEN delivery identity
   * (`hasEngagementCapability(HOST_MEETINGS)`) — the same pair admit/deny uses, and the
   * server-side re-check of the very `canHost` the panel gated its button on.
   *
   * ⚠ RATE-LIMITED, AND ORDERED AFTER VALIDATION BUT BEFORE THE SERVICE, exactly as the
   * invite route is: validation first so a malformed id cannot consume somebody's window, the
   * limiter before the service so a refused request costs no database work and emits no mail.
   * FAIL-CLOSED — a Redis outage answers `503`, never "carry on unlimited".
   *
   * ⚠ NO `404` FOR THE WRONG-SHAPE ROW. A nonexistent id, another meeting's id, a revoked row
   * and a non-holder all answer `404 guest_not_found` / `404 meeting_not_found` identically;
   * `409 guest_link_not_resendable` is reachable ONLY after both gates pass, so it is not an
   * oracle. There is still no `403` anywhere on this surface.
   */
  fastify.post(
    '/meetings/:meetingId/guests/:guestId/resend-link',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (userId === null) return;

      const params = parseGuestParams(req.params, reply);
      if (params === null) return;

      if (await enforceResendRateLimit(userId, params.guestId, params.meetingId, reply)) return;

      try {
        const result = await resendGuestJoinLink({
          meetingId: params.meetingId,
          guestId: params.guestId,
          actorUserId: userId,
        });
        if (!result.ok) {
          sendGuestError(reply, result.code, {
            route: 'resend',
            meetingId: params.meetingId,
            guestId: params.guestId,
            userId,
          });
          return;
        }
        reply.code(200).send({ id: result.id, expiresAt: result.expiresAt });
      } catch (error) {
        // ⚠ NO EMAIL ADDRESS AND NO TOKEN IN THIS LOG — ids only.
        log.error(
          {
            meetingId: params.meetingId,
            guestId: params.guestId,
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Guest link re-send failed'
        );
        throw error;
      }
    }
  );

  log.info('Registered meeting guest routes');
}
