/**
 * BAL-527 — per-wallet rate limit on mandate SetupIntent creation, reusing `checkRateLimit`
 * (`rate-limiter.ts`) exactly as `routes/meetings/end.ts` does.
 *
 * ⚠ WHY A SHARED MODULE IN `lib/`, NOT A SECOND COPY PER ROUTE. Both
 * `routes/credit/setup-intent.ts` (whose `new_card` arm calls `createSetupIntent` and whose
 * `saved_card` arm calls `confirmSavedCardMandate`) and `routes/stripe/setup-intent.ts` mint
 * mandate SetupIntents and need the identical guard. Per
 * `routes/meetings/guards.ts`'s own docblock, a second copy of a rate-limit guard is a guaranteed
 * jscpd hit and — worse — a second place for the numbers or the fail-closed posture to drift. The
 * two consumers live in different route folders, so the shared module goes in `lib/`, alongside
 * `rate-limit-prehandler.ts` and `with-deadline.ts`.
 *
 * ⚠ WHY `walletId`, NOT `request.ip` OR `actorUserId`. `createRateLimitPreHandler` hardcodes
 * `request.ip`, and both routes sit behind `requireInternalAuth` — every request carries the
 * Vercel egress IP, so an IP bucket would be one GLOBAL bucket for the whole platform.
 *
 * ⚠ FIX ROUND (security HIGH) — THE REASON `actorUserId` IS REJECTED IS **NOT** "it is a body
 * field". Both fields are declared in the same Zod object (`routes/credit/setup-intent.ts:16`
 * for `walletId`, `:38` for `actorUserId`), so "comes from the body" cannot discriminate them.
 * The real argument is what rotating each one does to the attack: rotating `actorUserId` leaves
 * the attack IDENTICAL — same wallet, same Stripe calls, a fresh bucket every request, i.e. no
 * bound at all — whereas rotating `walletId` CHANGES THE TARGET, so any single wallet stays
 * metered no matter what the attacker sends. `walletId` is the resource actually being
 * protected. (Additionally, on all five web callers below the wallet is derived server-side from
 * the session's company behind a `MANAGE_BILLING` gate, so no browser input reaches it — but the
 * bucket has to hold against a direct `INTERNAL_API_SECRET` poster too, and it does.)
 *
 * ⚠ ONE BUCKET PER WALLET IS THE POINT — IT IS SHARED BY EVERY `MANAGE_BILLING` HOLDER ON THE
 * COMPANY AND BY **FIVE** PRODUCTION ENTRY POINTS, not the three the design chain named. Covering
 * both arms of `POST /credit/setup-intent` pulled in two more:
 *   1. `startCardCaptureAction`               `apps/web/src/lib/credit/actions.ts:1037`
 *   2. `resolveMandateOutcome` — `new_card`   `actions.ts:476`
 *   3. `startContinueToMandate`               `redeem/_actions/start-continue-to-mandate.ts:79`
 *   4. `resolveMandateOutcome` — `saved_card` `actions.ts:479`
 *   5. `armSavedCardMandateAction`            `actions.ts:980`
 * The ≤ 90-calls arithmetic below SURVIVES the two additions rather than silently having covered
 * them: 4 and 5 land on `confirmSavedCardMandate`, which never reaches `ensureCustomer` and so
 * costs exactly **1** Stripe call per request against the same ceiling.
 *
 * ⚠ FAIL **CLOSED**. FIX ROUND (review MEDIUM) — `rate-limit-prehandler.ts:31-35` is NOT the
 * governing precedent and must not be half-quoted as if it were: its fail-CLOSED criterion is a
 * third-party vendor round-trip **AND** a response cache in front of it that is ALSO Redis, so a
 * Redis outage removes cache and limiter together. There is no such cache here, so that second
 * conjunct is false. The precedent that does govern is `routes/meetings/end.ts:20-28`, which
 * fails closed because "an unmetered destructive write path during a Redis outage is precisely
 * the window an attacker waits for". The shared property is an unmetered WRITE PATH left open
 * for the length of an outage — not destructiveness: nothing here is irreversible the way ending
 * a meeting is. What an unmetered window costs instead is up to three real Stripe calls per
 * request (`customers.create`, `customers.update`, `setupIntents.create`) against a vendor
 * account whose rate-limit budget every other money path shares, plus a Customer and a
 * SetupIntent per 24h key window.
 *
 * ⚠ THE COST OF FAILING CLOSED, NAMED RATHER THAN LEFT IMPLICIT. Card capture is the ONLY
 * in-product path by which a client with an open receivable can remediate it (see the
 * `SETTLEMENT_OUTSTANDING_MESSAGE` docblock, BAL-516) — so a Redis outage strands those clients
 * until Redis returns. This is an ARGUED trade, not an unnoticed side effect: a Redis outage
 * already degrades BullMQ platform-wide, and the refusal here is a retryable `503`, not a dead
 * end — every one of the five callers above already degrades a `CreditApiError` from this seam
 * into its existing generic retryable arm (`error: 'error'` / `outcome: 'failed'` /
 * `status: 'error'`), with no charge, mandate or ledger effect.
 *
 * ⚠ `withDeadline` IS MANDATORY, NOT DEFENSIVE POLISH. `getRedis()` sets
 * `maxRetriesPerRequest: null` (BullMQ requires it), and ioredis only flushes pending commands
 * with an error when that option is a NUMBER — with `null`, a command issued during a Redis
 * outage is parked in the offline queue and NEVER SETTLES. Without `withDeadline` the `catch`
 * below is dead code during the exact outage it exists for, and the request hangs on a Fastify
 * connection until an upstream proxy times it out. See `with-deadline.ts` for the verified
 * mechanism.
 *
 * ⚠ WHAT 30/HOUR/WALLET ACTUALLY BUYS. The BAL-527 idempotency key on `createSetupIntent` bounds
 * SETUPINTENT creation to one per wallet per 24h, no matter how many times this limit is pressed.
 * (FIX ROUND, review MEDIUM: the one-Customer bound on that path is NOT this key's — it comes
 * from the pre-existing `stripe-customer-{walletId}` key at `services/stripe/mandate.ts:173` and
 * predates BAL-527. Do not credit it to either BAL-527 control.) This limit bounds the thing
 * neither key can: API CALLS. A `new_card` request still makes up to three real Stripe calls even
 * when every one of them is a replay (`customers.create`, `customers.update` — unkeyed, a real
 * write every time — and `setupIntents.create`); a `saved_card` request makes exactly one. So the
 * honest bound this ceiling buys is **≤ 90 Stripe API calls per wallet per hour**, not "≤ 30
 * SetupIntents" — the key already gives the latter for free. 30 is a PRODUCT NUMBER, not a
 * physical limit — sized with headroom over the realistic ~20-25/hour ceiling from two or three
 * admins on one company exercising the entry points at once, and it mirrors
 * `BOOKING_USER_RATE_LIMIT` (the closest analogue: a user-initiated, conversion-critical,
 * vendor-touching write) rather than inventing a number. A natural early migration when
 * `platform_config` (BAL-398) lands.
 */
import type { FastifyReply } from 'fastify';
import { createLogger } from '@balo/shared/logging';
import { checkRateLimit, RATE_LIMIT_DEADLINE_MS, type RateLimitConfig } from './rate-limiter.js';
import { getRedis } from './redis.js';
import { withDeadline } from './with-deadline.js';

const log = createLogger('setup-intent-rate-limit');

export const MANDATE_SETUP_WALLET_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:mandate-setup:wallet',
  maxRequests: 30,
  windowSeconds: 3600,
};

/**
 * Consume one token from the wallet's mandate-SetupIntent bucket. Returns `true` when the reply
 * has ALREADY been sent (`429` over the limit, `503` on a Redis failure or hang) — the caller
 * must return immediately in that case. Returns `false` when the request may proceed.
 *
 * Call this AFTER the cheap schema validation and BEFORE any Stripe or database work, so a
 * malformed request never consumes a wallet's window and a limited request costs no vendor call
 * at all (the same ordering `routes/meetings/end.ts` uses).
 */
export async function enforceMandateSetupRateLimit(
  walletId: string,
  reply: FastifyReply
): Promise<boolean> {
  try {
    const result = await withDeadline(
      () => checkRateLimit(getRedis(), MANDATE_SETUP_WALLET_RATE_LIMIT, walletId),
      {
        deadlineMs: RATE_LIMIT_DEADLINE_MS,
        label: `rate limit ${MANDATE_SETUP_WALLET_RATE_LIMIT.keyPrefix}`,
      }
    );
    if (result.allowed) {
      return false;
    }
    log.warn(
      { walletId, keyPrefix: MANDATE_SETUP_WALLET_RATE_LIMIT.keyPrefix },
      'Mandate SetupIntent rate-limited'
    );
    reply
      .header('Retry-After', String(result.ttlSeconds))
      .code(429)
      .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
    return true;
  } catch (error: unknown) {
    log.error(
      {
        keyPrefix: MANDATE_SETUP_WALLET_RATE_LIMIT.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Mandate SetupIntent rate limit unavailable — failing CLOSED'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}
