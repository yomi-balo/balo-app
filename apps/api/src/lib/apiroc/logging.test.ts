import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
const { reachAxiosInstance } = await import('./interceptor.js');
const { suppressSdkConsoleLogging } = await import('./logging.js');

describe('suppressSdkConsoleLogging — behavioural, tier-agnostic', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
    mockLog.info.mockClear();
  });

  it('after suppression, a forced SDK API error writes NOTHING unstructured to console/stdout/stderr', () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test-key' });
    const tier = suppressSdkConsoleLogging();
    expect(['prototype', 'failed']).toContain(tier);
    // A4 (review) — this used to be checked only inside `if (tier !== 'failed')` below,
    // wrapping every assertion after it and letting total suppression failure pass green.
    // Assert it outright: a `tier === 'failed'` result is itself the bug this test exists
    // to catch (winston tier 3 is verified to work — `logging.test.ts`'s own second
    // describe block — so this is not a flaky "known sometimes fails" case).
    expect(tier).not.toBe('failed');

    const { axiosInstance } = reachAxiosInstance(api);
    expect(axiosInstance).not.toBeNull();
    const handlers = axiosInstance?.interceptors.response.handlers ?? [];
    const sdkHandler = handlers.find(
      (h): h is { fulfilled?: unknown; rejected: (error: unknown) => unknown } =>
        h !== null && typeof h.rejected === 'function'
    );
    expect(sdkHandler).toBeDefined();

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // BAL-467 fix brief round 2, item 2 — under Vitest, `console` is a CUSTOM `Console`
    // instance (`console._stdout !== process.stdout`, measured), and winston's `Console`
    // transport writes via `console._stdout.write` / `console._stderr.write`, NOT via
    // `console.log`/`console.warn`/`console.error` or `process.stdout`/`process.stderr`
    // directly. The three spies above (belt-and-braces) therefore watch sinks winston
    // never writes to when they differ from these — sabotage-verified (see the round-2
    // fix brief: returning `attemptPrototypeSuppression() === true` WITHOUT patching
    // `Console.prototype.log` left this test green under the old process.stdout/stderr
    // spies). Spy on the sinks winston ACTUALLY targets, falling back to the real streams
    // for a non-Vitest `console` shape — and dedupe so the same stream is never spied
    // twice (a second `vi.spyOn` on an already-spied method wraps the first spy instead
    // of the original, which breaks clean `mockRestore()` unwind).
    const consoleSinks = console as unknown as {
      _stdout?: NodeJS.WritableStream;
      _stderr?: NodeJS.WritableStream;
    };
    const sinkStreams = [
      consoleSinks._stdout ?? process.stdout,
      consoleSinks._stderr ?? process.stderr,
    ];
    const uniqueSinkStreams = Array.from(new Set(sinkStreams));
    const sinkWriteSpies = uniqueSinkStreams.map((stream) =>
      vi.spyOn(stream, 'write').mockImplementation(() => true)
    );

    const syntheticAxiosError = {
      message: 'Request failed with status code 500',
      config: { method: 'get', url: '/api/v1/calendars' },
      response: { status: 500, headers: {}, data: { message: 'Internal error' } },
    };

    // CRITICAL #3 (review) — these assertions used to run AFTER the `finally` block's
    // `mockRestore()` calls. Under Vitest 4, `mockRestore()` clears the mock's call
    // history (in addition to restoring the original implementation), so
    // `.not.toHaveBeenCalled()` checked afterwards can never fail regardless of what
    // actually happened — a vacuous assertion. Asserting BEFORE `finally` runs restores
    // the test's teeth; the spies are still restored unconditionally either way.
    try {
      // The SDK's own response-interceptor `rejected` handler logs through its module-level
      // winston logger (level `error`) and then THROWS synchronously (dist/index.js) — driving
      // it directly, with no network call, exercises exactly the call tier 3 suppresses.
      expect(() => sdkHandler?.rejected(syntheticAxiosError)).toThrow();

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      for (const sinkWriteSpy of sinkWriteSpies) {
        expect(sinkWriteSpy).not.toHaveBeenCalled();
      }
    } finally {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      for (const sinkWriteSpy of sinkWriteSpies) {
        sinkWriteSpy.mockRestore();
      }
    }
  });

  it('reports console-suppression failure through Pino exactly once, never through console.*, when every tier fails', async () => {
    // BAL-467 fix brief round 2, item 12 — the un-mocked call always reaches tier 3
    // (verified working against the real SDK/winston in this environment), so
    // `if (tier === 'failed')` never ran and the test's stated purpose — asserting the
    // `failed` path — was dead. Force the failure path deterministically by making tier
    // 3's `require('winston')` throw, via a fresh module graph with `node:module` mocked.
    vi.resetModules();
    vi.doMock('node:module', async () => {
      const actual = await vi.importActual<typeof import('node:module')>('node:module');
      return {
        ...actual,
        createRequire: (...args: Parameters<typeof actual.createRequire>) => {
          const realRequire = actual.createRequire(...args);
          const failingWinstonRequire = (id: string): unknown => {
            if (id === 'winston') {
              throw new Error('BAL-467 test: simulated winston resolution failure');
            }
            return realRequire(id);
          };
          return Object.assign(failingWinstonRequire, realRequire);
        },
      };
    });

    try {
      const { suppressSdkConsoleLogging: suppressWithFailingTier3 } = await import('./logging.js');
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const tier = suppressWithFailingTier3();

        // Move above `mockRestore()` — CRITICAL #3 / A3's exact defect, unfixed here in
        // round 1 (`mockRestore()` at what was line 89 preceded this assertion at line 97).
        expect(tier).toBe('failed');
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ tiersAttempted: expect.any(Array) }),
          'apiroc_sdk_console_suppression_failed'
        );
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleWarnSpy.mockRestore();
      }
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });
});

describe('winston is not a direct Balo dependency (the premise tier 3 depends on)', () => {
  function collectPackageJsonPaths(repoRoot: string): string[] {
    const paths = [path.join(repoRoot, 'package.json')];
    for (const group of ['apps', 'packages']) {
      const groupDir = path.join(repoRoot, group);
      let entryNames: string[] = [];
      try {
        entryNames = readdirSync(groupDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of entryNames) {
        const pkgPath = path.join(groupDir, name, 'package.json');
        if (existsSync(pkgPath)) {
          paths.push(pkgPath);
        }
      }
    }
    return paths;
  }

  it('no package.json in the repo declares winston as a direct dependency', () => {
    const here = fileURLToPath(import.meta.url);
    // apps/api/src/lib/apiroc/logging.test.ts -> repo root is five levels up.
    const repoRoot = path.resolve(path.dirname(here), '../../../../..');
    const packageJsonPaths = collectPackageJsonPaths(repoRoot);

    // Positive control: discovery actually found the workspace, not a truncated/empty scan.
    expect(packageJsonPaths.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const pkgPath of packageJsonPaths) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      if (pkg.dependencies?.winston !== undefined || pkg.devDependencies?.winston !== undefined) {
        offenders.push(pkgPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the Apiroc SDK itself DOES declare winston — the tier-3 require-rooting premise', () => {
    const here = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(here), '../../../../..');
    const sdkPkgPath = path.join(
      repoRoot,
      'node_modules/.pnpm',
      readdirSync(path.join(repoRoot, 'node_modules/.pnpm')).find((entry) =>
        entry.startsWith('@apiroc+unified-calendar-api-node-sdk@')
      ) ?? '',
      'node_modules/@apiroc/unified-calendar-api-node-sdk/package.json'
    );
    expect(existsSync(sdkPkgPath)).toBe(true);
    const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
    };
    expect(sdkPkg.dependencies?.winston).toBeDefined();
  });
});
