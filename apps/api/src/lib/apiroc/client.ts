import { UnifiedCalendarApi } from '@apiroc/unified-calendar-api-node-sdk';
import { ApirocConfigError } from './errors.js';
import { installInterceptor, type ApirocInterceptorPosition } from './interceptor.js';
import { log, suppressSdkConsoleLogging, type ApirocConsoleSuppressionTier } from './logging.js';

export interface ApirocInitReport {
  readonly interceptorInstalled: boolean;
  readonly interceptorPosition: ApirocInterceptorPosition;
  readonly consoleSuppression: ApirocConsoleSuppressionTier;
  readonly sdkShape: {
    readonly reachedBaseClient: boolean;
    readonly reachedClient: boolean;
  };
}

let clientSingleton: UnifiedCalendarApi | null = null;
let initReport: ApirocInitReport | null = null;

/**
 * Installs the capture interceptor (`interceptor.ts`) and suppresses the SDK's own winston
 * Console transport (`logging.ts`). Exported (not inlined into `getApirocClient`) so
 * `sdk-shape.test.ts` can drive it directly against a hand-constructed SDK instance, without
 * needing `APIROC_API_KEY` set.
 */
export function initApirocBoundary(api: UnifiedCalendarApi): ApirocInitReport {
  const interceptorReport = installInterceptor(api);
  const consoleSuppression = suppressSdkConsoleLogging();

  const report: ApirocInitReport = {
    interceptorInstalled: interceptorReport.interceptorInstalled,
    interceptorPosition: interceptorReport.interceptorPosition,
    consoleSuppression,
    sdkShape: {
      reachedBaseClient: interceptorReport.reachedBaseClient,
      reachedClient: interceptorReport.reachedClient,
    },
  };

  log.info(report, 'apiroc_boundary_initialised');
  return report;
}

/**
 * The lazily-constructed Apiroc SDK singleton (`lib/stripe.ts` precedent — deferred, not a
 * module-level `const`). Merely importing this module never constructs a client: the SDK
 * constructor throws on a missing API key, which would crash the shared Fastify app builder
 * (and every route test) at import time when `APIROC_API_KEY` is unset. Construction happens
 * on first real use.
 *
 * Only `APIROC_API_KEY` is introduced by this ticket. `APIROC_APP_ID` and
 * `APIROC_REDIRECT_URI` belong to the connect flow (BAL-396) and are not read here.
 */
export function getApirocClient(): UnifiedCalendarApi {
  if (clientSingleton) {
    return clientSingleton;
  }
  const apiKey = process.env.APIROC_API_KEY;
  if (!apiKey) {
    throw new ApirocConfigError('APIROC_API_KEY is not set');
  }
  const api = new UnifiedCalendarApi({ apiKey });
  initReport = initApirocBoundary(api);
  clientSingleton = api;
  return api;
}

/** Exposed for the shape-pinning test and for a startup diagnostic log. `null` until the first
 * `getApirocClient()` call. */
export function getApirocInitReport(): ApirocInitReport | null {
  return initReport;
}

/** Test-only: resets the lazy singleton so each test can exercise a clean construction path. */
export function __resetApirocClientForTests(): void {
  clientSingleton = null;
  initReport = null;
}
