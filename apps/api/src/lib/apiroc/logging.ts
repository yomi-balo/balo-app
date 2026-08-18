import { createRequire } from 'node:module';
import { createLogger } from '@balo/shared/logging';

/** All Apiroc logging goes through this — `apps/api` convention (`lib/require-auth.ts`,
 * `jobs/availability-cache.ts`). Never `console.*`. */
export const log = createLogger('apiroc');

export type ApirocConsoleSuppressionTier = 'prototype' | 'failed';

/**
 * The SDK builds a MODULE-LEVEL winston logger with an unconditional `Console` transport and
 * logs every API error at level `error` (winston level 0) — no `LOG_LEVEL` value suppresses
 * it. Those lines bypass Pino, carry no `requestId`/`userId`, never reach Axiom, and pollute
 * Railway stdout (CLAUDE.md logging rules). Worse: the same logger emits request/response at
 * `debug`, and `endUserAccounts.getCredentials()` returns raw provider access/refresh tokens —
 * an unredacted-secret-to-stdout path if anyone sets `LOG_LEVEL=debug`. Suppression is a
 * security requirement, not tidiness.
 *
 * Fix brief round 2, item 11 — this file used to also carry two earlier "tiers" (silence a
 * `logger` the SDK module exports; silence a `logger` property on the reached instance).
 * Both were confirmed absent from the installed SDK 2.0.1 by their own docblocks ("scaffolding
 * for a future SDK version, not a live path today") — i.e. speculative dead code (CLAUDE.md:
 * "No commented-out code or dead code"), and the reason this file sat at 61% line coverage.
 * Deleted. The one tier that actually works for 2.0.1 (below) is the only one kept; if a
 * future SDK version exports or attaches a `logger` some other way, re-add a tier THEN, driven
 * by a real reachable shape, not a shape nothing in production ever produces.
 */

/**
 * Tier 3 — the one that actually works for 2.0.1. `winston` is a direct dependency of the SDK
 * (confirmed in the published tarball's `package.json`, not bundled into `dist`), so a
 * `require()` rooted at the SDK's own resolved path reaches the SDK's exact winston instance —
 * the same module-cache entry its `import winston from 'winston'` reads, since Node's ESM/CJS
 * interop for a CJS package shares one cache entry per resolved file regardless of which
 * loader touched it first.
 *
 * ⚠ Resolving `winston` directly from `apps/api` would, under pnpm's strict (non-hoisted)
 * node_modules, either fail to resolve at all or (if some other dependency happens to pull it
 * in) resolve to a DIFFERENT installed copy than the SDK's — hence rooting the `require` at
 * the SDK's own package directory via a second `createRequire`.
 *
 * This tier is safe precisely because Balo has no winston of its own: `winston` appears in no
 * `package.json` in this repo (`logging.test.ts` pins that premise) — the only winston in the
 * process after this ticket is the SDK's, so mutating `Console.prototype.log` cannot affect
 * anything else.
 */
function attemptPrototypeSuppression(): boolean {
  try {
    const localRequire = createRequire(import.meta.url);
    const sdkEntryPath = localRequire.resolve('@apiroc/unified-calendar-api-node-sdk');
    const sdkRequire = createRequire(sdkEntryPath);
    const winstonModule = sdkRequire('winston') as {
      transports?: { Console?: { prototype?: Record<string, unknown> } };
    };
    const consoleTransportPrototype = winstonModule.transports?.Console?.prototype;
    if (!consoleTransportPrototype || typeof consoleTransportPrototype.log !== 'function') {
      return false;
    }
    consoleTransportPrototype.log = function apirocSuppressedWinstonConsoleLog(
      _info: unknown,
      callback?: () => void
    ): void {
      if (typeof callback === 'function') {
        callback();
      }
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts prototype suppression, never throwing. Returns the outcome for `ApirocInitReport`.
 *
 * Fix brief round 2, item 11 — tiers 1/2 (SDK-export / instance `logger` silencing) were
 * deleted as speculative dead code, along with the `api`/`sdkModule` parameters that only
 * they consumed. If a future SDK version needs a shape-driven tier reinstated, add the
 * parameter back THEN, driven by a real reachable shape.
 */
export function suppressSdkConsoleLogging(): ApirocConsoleSuppressionTier {
  if (attemptPrototypeSuppression()) {
    return 'prototype';
  }
  log.warn({ tiersAttempted: ['prototype'] }, 'apiroc_sdk_console_suppression_failed');
  return 'failed';
}
