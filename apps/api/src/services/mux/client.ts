/**
 * BAL-473 (OD-5) — the ONE Mux client module. Every Mux SDK call in this feature goes through
 * `getMuxClient()`.
 *
 * ⚠ WHY THE SDK, NOT BARE `fetch` (OD-5, restated briefly — see `.claude/skills/mux/SKILL.md`
 * for the full argument). `@mux/mux-node@15.0.0` has ZERO runtime dependencies (so the
 * tsup-bundling risk that would motivate avoiding it does not exist) and natively provides
 * BOTH halves this feature would otherwise hand-roll against a vendor spec: RS256 JWT signing
 * for signed playback (`playback.ts`) and `Webhooks.verifySignature` (`webhook-signature.ts`).
 * Hand-rolling either is exactly where a vendor-spec bug hides — the Daily module's hex/base64
 * near-miss is the cautionary precedent.
 *
 * ⚠ READ LAZILY, INSIDE A FUNCTION — never a module-level `const`. A module-level
 * `new Mux({...})` would make merely IMPORTING this module fail in every route/job test and in
 * the shared Fastify app builder whenever the token pair is unset. This is `getDailyApiKey`'s /
 * `getStripeClient`'s pattern, restated for Mux.
 */
import Mux from '@mux/mux-node';
import { MuxConfigError } from './errors.js';

let cachedClient: Mux | undefined;

/**
 * The lazily-constructed Mux client, cached across calls within one process. `MUX_TOKEN_ID` /
 * `MUX_TOKEN_SECRET` are the SDK's OWN default env var names (`ClientOptions.tokenId` /
 * `tokenSecret` default to `process.env['MUX_TOKEN_ID']` / `['MUX_TOKEN_SECRET']`), so no
 * explicit option is needed for those two — but we still validate their presence here so a
 * missing pair throws a named `MuxConfigError` at the FIRST call site rather than surfacing as
 * an opaque 401 from Mux's API.
 *
 * ⚠ DOES NOT CONFIGURE `webhookSecret` / `jwtSigningKey` / `jwtPrivateKey` on the client.
 * `webhook-signature.ts` and `playback.ts` each read their OWN env vars
 * (`MUX_WEBHOOK_SECRET`, `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_KEY_PRIVATE` — deliberately NOT the
 * SDK's own `MUX_SIGNING_KEY`/`MUX_PRIVATE_KEY` default names, per the ticket's naming) and
 * pass them explicitly per call, so a caller can never accidentally rely on an SDK default this
 * platform has not configured.
 */
export function getMuxClient(): Mux {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new MuxConfigError('MUX_TOKEN_ID / MUX_TOKEN_SECRET are not set');
  }
  cachedClient = new Mux({ tokenId, tokenSecret });
  return cachedClient;
}

/** Test-only: drop the cached client so a test can reconfigure env vars and re-resolve. */
export function resetMuxClientForTest(): void {
  cachedClient = undefined;
}
