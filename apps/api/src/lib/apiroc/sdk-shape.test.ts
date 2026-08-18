import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { stripComments } from '@balo/shared/testing';

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

const { UnifiedCalendarApi } = await import('@apiroc/unified-calendar-api-node-sdk');
const { reachAxiosInstance, installInterceptor } = await import('./interceptor.js');
const { initApirocBoundary } = await import('./client.js');

/**
 * ⚠⚠ THE BAR THIS FILE IS WRITTEN TO: an SDK (`@apiroc/unified-calendar-api-node-sdk`) or
 * bundler bump must fail LOUDLY here rather than silently degrading the private-field reach in
 * `interceptor.ts` to status-only branching in production. Pinned against SDK **2.0.1**:
 * `UnifiedCalendarApi.baseClient` is `private` at `dist/index.d.ts:751`; `BaseClient.client` is
 * `private` at `dist/index.d.ts:526`. If any assertion below starts failing, re-verify the
 * private reach against the new `dist/index.d.ts` before touching this file's expectations.
 */
describe('apiroc SDK private-field shape pin (2.0.1)', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
    mockLog.info.mockClear();
  });

  it('[hop 1 / dist/index.d.ts:751] UnifiedCalendarApi exposes a reachable baseClient object', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test' });
    const baseClient = (api as unknown as Record<string, unknown>).baseClient;
    expect(
      typeof baseClient === 'object' && baseClient !== null,
      'SDK 2.0.1: UnifiedCalendarApi.baseClient (private, dist/index.d.ts:751) is no longer a reachable object — re-verify interceptor.ts::reachAxiosInstance'
    ).toBe(true);
  });

  it('[hop 2 / dist/index.d.ts:526] BaseClient exposes a reachable client (axios) object', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test' });
    const { axiosInstance, reachedBaseClient, reachedClient } = reachAxiosInstance(api);
    expect(reachedBaseClient, 'hop 1 (baseClient) failed').toBe(true);
    expect(
      reachedClient,
      'SDK 2.0.1: BaseClient.client (private, dist/index.d.ts:526) is no longer reachable / no longer axios-shaped'
    ).toBe(true);
    expect(axiosInstance).not.toBeNull();
  });

  it('the reached client exposes interceptors.response.use as a function (axios InterceptorManager shape)', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test' });
    const { axiosInstance } = reachAxiosInstance(api);
    expect(typeof axiosInstance?.interceptors.response.use).toBe('function');
  });

  it('the SDK has already registered >=1 response interceptor of its own before we touch it', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test' });
    const { axiosInstance } = reachAxiosInstance(api);
    const handlers = axiosInstance?.interceptors.response.handlers;
    expect(Array.isArray(handlers)).toBe(true);
    expect(
      (handlers ?? []).length,
      'the SDK no longer registers its own response interceptor in the BaseClient constructor — the reorder-to-front dance in installInterceptor() is now unnecessary and should be deleted'
    ).toBeGreaterThanOrEqual(1);
  });

  it('initApirocBoundary installs our interceptor at index 0 (interceptorPosition "first")', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test' });
    const { axiosInstance } = reachAxiosInstance(api);
    expect(axiosInstance).not.toBeNull();

    // Fix brief round 2, item 13 — `expect(handlers[0]).not.toBeNull()` alone does not
    // assert handler[0] is OURS, which is what plan §5b.5 asked for (a non-null slot could
    // just as easily be the SDK's own handler if the reorder silently no-opped). Capture the
    // exact `rejected` reference `installInterceptor` registers via `.use()` and assert
    // identity against `handlers[0]` directly.
    const responseInterceptors = axiosInstance!.interceptors.response;
    let capturedRejected: unknown;
    const realUse = responseInterceptors.use.bind(responseInterceptors);
    vi.spyOn(responseInterceptors, 'use').mockImplementation(
      (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) => {
        capturedRejected = onRejected;
        return realUse(onFulfilled, onRejected);
      }
    );

    const report = initApirocBoundary(api);

    expect(report.interceptorInstalled).toBe(true);
    expect(report.interceptorPosition).toBe('first');

    const handlers = responseInterceptors.handlers ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    expect(capturedRejected).toBeDefined();
    // Ours was unshifted to the front — the SDK's own handler (registered first) is now
    // behind it. Identity, not merely non-null.
    expect(handlers[0]?.rejected).toBe(capturedRejected);
  });

  it('negative control: degrades without throwing when the private shape is entirely absent, and warns exactly once', () => {
    let report: ReturnType<typeof installInterceptor> | undefined;
    expect(() => {
      report = installInterceptor({});
    }).not.toThrow();

    expect(report).toBeDefined();
    expect(report?.interceptorInstalled).toBe(false);
    expect(report?.interceptorPosition).toBe('none');
    expect(report?.reachedBaseClient).toBe(false);
    expect(report?.reachedClient).toBe(false);

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reachedBaseClient: false, reachedClient: false }),
      'apiroc_interceptor_reach_failed'
    );
  });

  it('negative control: degrades gracefully when baseClient exists but client does not look like axios', () => {
    const report = installInterceptor({ baseClient: { notClient: true } });
    expect(report.interceptorInstalled).toBe(false);
    expect(report.interceptorPosition).toBe('none');
    expect(report.reachedBaseClient).toBe(true);
    expect(report.reachedClient).toBe(false);
  });

  describe('source scan — apps/api/src/lib/apiroc/**', () => {
    function readModuleSources(): ReadonlyArray<{ file: string; stripped: string }> {
      const here = fileURLToPath(import.meta.url);
      const dir = path.dirname(here);
      // D5 (review SUGGESTION) — non-recursive readdirSync silently stopped applying the
      // ban the moment anyone added a `lib/apiroc/<subdir>/`. `{ recursive: true }` (Node
      // 20+) walks the whole tree; entries come back as subpaths (`sub/file.ts`), which
      // `path.join(dir, name)` handles unchanged.
      return readdirSync(dir, { recursive: true })
        .filter(
          (name): name is string =>
            typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts')
        )
        .map((name) => {
          const filePath = path.join(dir, name);
          return { file: name, stripped: stripComments(readFileSync(filePath, 'utf-8')) };
        });
    }

    it('never branches on error.constructor.name (bundler-mangles it)', () => {
      const sources = readModuleSources();
      expect(sources.length).toBeGreaterThan(0); // positive control — the scan found files
      for (const { file, stripped } of sources) {
        expect(stripped.includes('constructor.name'), `${file} references constructor.name`).toBe(
          false
        );
      }
    });

    it('never reads or stores a syncToken (keeps this module out of Scan A of sync-token-parity.test.ts)', () => {
      const sources = readModuleSources();
      for (const { file, stripped } of sources) {
        expect(stripped.includes('syncToken'), `${file} references syncToken`).toBe(false);
      }
    });
  });

  describe('route-template premise (fix brief round 2, item 9)', () => {
    /**
     * `interceptor.ts`'s `sanitizeRouteTemplate` keeps `ROUTE_TEMPLATE_KEPT_SEGMENTS = 3`
     * segments (`"api", "v1", "<resource>"`) on the premise that every SDK request path is
     * `/api/v1/<resource>/…` — so segments 4+ (the `endUserAccountId`, and for Google
     * accounts the `calendarId`, which IS the expert's email) are always the ones collapsed
     * to a count. This pins that premise against the INSTALLED SDK's `dist/index.js` so a
     * future SDK version that changes its path shape (e.g. dropping the `/api/v1` prefix)
     * fails LOUDLY here rather than silently letting a shorter, email-bearing path template
     * survive `sanitizeRouteTemplate` unredacted. `sanitizeRouteTemplate` also now
     * unconditionally redacts any kept segment that looks like an email as defence in depth
     * (see that function's docblock) — this test guards the PREMISE, not a substitute for it.
     */
    function readInstalledSdkSource(): string {
      const localRequire = createRequire(import.meta.url);
      const sdkEntryPath = localRequire.resolve('@apiroc/unified-calendar-api-node-sdk');
      return readFileSync(sdkEntryPath, 'utf-8');
    }

    it('every SDK request-path template literal still carries the /api/v1/ prefix', () => {
      const source = readInstalledSdkSource();
      // Every request path in the SDK is built as a template literal beginning with
      // `/api/v1/...`. Collect all such literals and assert none of them deviates.
      const pathTemplateLiterals = source.match(/`\/api\/v1\/[^`]*`/g) ?? [];
      expect(
        pathTemplateLiterals.length,
        'No `/api/v1/...` template literals found in the installed SDK — either the SDK ' +
          'stopped building paths this way (re-verify sanitizeRouteTemplate against the new ' +
          'shape) or this scan broke.'
      ).toBeGreaterThan(0);

      // Independent count: every backtick-delimited path-shaped template literal (starts
      // with `/`) in the resource files must be one of the /api/v1/ ones above — i.e. there
      // is no OTHER path shape the SDK also uses that this scan missed.
      const anyPathTemplateLiterals = source.match(/`\/[a-zA-Z][^`]*`/g) ?? [];
      const nonApiV1 = anyPathTemplateLiterals.filter(
        (literal) => !literal.startsWith('`/api/v1/')
      );
      expect(
        nonApiV1,
        'Found request path template literal(s) that do NOT start with /api/v1/ — the ' +
          '3-segment-keep premise in sanitizeRouteTemplate no longer covers every SDK path.'
      ).toEqual([]);
    });
  });
});
