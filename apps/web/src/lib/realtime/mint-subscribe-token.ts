import 'server-only';

import type * as Ably from 'ably';
import { getAblyRest, isRealtimeConfigured } from './ably-server';

/**
 * BAL-437 — ⚠⚠ **THE ONE PLACE A CLIENT-BOUND ABLY TOKEN IS MINTED.**
 *
 * Three surfaces now need the identical tail — the project-request island, the case island and
 * the in-call panel — and all three want exactly the same thing: `isRealtimeConfigured()` →
 * `getAblyRest()` → `createTokenRequest({ clientId, ttl, capability })` over an EXPLICIT,
 * SUBSCRIBE-ONLY channel map. A third verbatim copy would be ~30 duplicated lines against two
 * existing ones and would trip SonarCloud's 3% new-code duplication gate; more importantly it
 * would be a third place for the subscribe-only invariant to drift.
 *
 * ⚠ BOTH SHIPPED CALLERS WERE MIGRATED ONTO THIS IN THE SAME PR. Extracting without migrating
 * produces THREE variants instead of two, which is strictly worse than doing nothing.
 *
 * ── ⚠⚠ WHAT THIS FUNCTION DELIBERATELY DOES **NOT** OWN ─────────────────────────────────
 *
 *   · **Authorization.** Every caller runs its own full tenancy gate FIRST and passes the
 *     channels that gate resolved. This function trusts its input completely, which is safe
 *     only because it is unreachable before a gate — keep it that way.
 *   · **The empty-channel copy.** The two shipped callers say different things ("No open
 *     conversations on this request." vs. a case's single thread), so emptiness is checked by
 *     the CALLER and the assertion below is a programming-error backstop, not a user path.
 *   · **The `disabled` log line.** Each caller logs with its own correlation ids
 *     (`requestId` / `engagementId` / `meetingId`), which is the whole value of that line.
 *
 * ── ⚠ WHY `createTokenRequest` AND NOT A JWT ────────────────────────────────────────────
 *
 * The `using-ably` vendor skill RECOMMENDS JWT for client auth; Balo deliberately uses Ably's
 * documented "Alternative". The skill itself notes JWTs "can be decoded by clients", and — more
 * decisively — Balo re-runs the FULL tenancy gate inside `authCallback` on every refresh, which
 * is the thing that makes {@link TOKEN_TTL_MS} a real bound on a revoked member's live
 * subscription rather than a decorative number. Do not migrate this to JWT.
 */

/**
 * Explicit token TTL (ms): bounds how long a revoked participant can keep a live subscription
 * (vs Ably's 60-minute default). ably-js auto-renews through `authCallback`, which re-runs the
 * caller's FULL gate on every refresh — so entitlement staleness is bounded by this value.
 *
 * ⚠ ONE DECLARATION. It used to be three, one per token action, which is exactly how three
 * "15 minutes" become 15, 15 and 60.
 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

export type MintSubscribeTokenResult =
  | { success: true; tokenRequest: Ably.TokenRequest }
  /** ⚠ `disabled` ⇒ NO `ABLY_API_KEY`. Not a denial — every surface still works over HTTP. */
  | { success: false; disabled: true };

export interface MintSubscribeTokenInput {
  /** ⚠ ALWAYS `users.id`, so Ably itself attributes every connection to a real user. */
  readonly clientId: string;
  /**
   * The FULLY-QUALIFIED channel names this actor may subscribe to, as the caller's gate
   * resolved them.
   *
   * ⚠⚠ NEVER A WILDCARD, AND THE TYPE CANNOT ENFORCE THAT — the assertion below does. A
   * wildcard here would hand one member a subscription to every thread on the platform.
   */
  readonly channels: readonly string[];
}

/**
 * Mint a SUBSCRIBE-ONLY Ably token request over an explicit channel list.
 *
 * @throws if `channels` is empty or contains a wildcard — both are programming errors the
 * caller must have prevented, and failing loudly is the only safe direction. (`'*'` in a
 * capability key is Ably's wildcard; a channel NAME can never legitimately contain one.)
 */
export async function mintSubscribeOnlyToken(
  input: MintSubscribeTokenInput
): Promise<MintSubscribeTokenResult> {
  const { clientId, channels } = input;

  if (channels.length === 0) {
    throw new Error('mintSubscribeOnlyToken: refusing to mint a token with no channels');
  }
  if (channels.some((channel) => channel.includes('*'))) {
    throw new Error('mintSubscribeOnlyToken: refusing to mint a wildcard capability');
  }

  if (!isRealtimeConfigured()) {
    return { success: false, disabled: true };
  }

  const rest = getAblyRest();
  if (rest === null) {
    // Unreachable after the isRealtimeConfigured() gate; defensive.
    return { success: false, disabled: true };
  }

  const tokenRequest = await rest.auth.createTokenRequest({
    clientId,
    ttl: TOKEN_TTL_MS,
    // ⚠ `['subscribe']` FOR EVERY CHANNEL, ALWAYS. A client on this platform never publishes:
    // the server publishes after validation, sanitisation and persist, which is what makes a
    // tampered client unable to spoof anything onto a channel (`ably-server.ts`).
    capability: JSON.stringify(
      Object.fromEntries(channels.map((channel) => [channel, ['subscribe']]))
    ),
  });

  return { success: true, tokenRequest };
}
