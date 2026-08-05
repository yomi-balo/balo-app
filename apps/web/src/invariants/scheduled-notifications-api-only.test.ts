import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BAL-420 / ADR-1047 Decision 11 — structural invariant: `apps/web` never reaches the
 * scheduled-notification repository.
 *
 * Decision 11 rules that **cancel never gets an HTTP route, ever**, because cancel is a
 * HIGHER-PRIVILEGE operation than publish: cancelling
 * `meeting_expert_absent:<meetingId>` suppresses the alert whose entire purpose is to tell
 * Balo that an expert did not show up for a paid consultation, and dedup keys are
 * deterministic and derived from entity ids, so targeting one specific victim's alert needs
 * no enumeration. `schedule` is barely better — `replace_pending` is itself a suppression
 * primitive, since a caller who can schedule key K can push a pending alert's
 * `scheduled_for` arbitrarily far out.
 *
 * ⚠ WITHOUT THIS TEST, "NO ROUTE" IS ONLY A CONVENTION, NOT A BOUNDARY.
 * `scheduledNotificationsRepository` is re-exported from `@balo/db`'s single entrypoint,
 * `apps/web` imports repositories from `@balo/db` routinely, and there is no
 * `no-restricted-imports` rule stopping it. A Server Action could today write
 *
 *     await scheduledNotificationsRepository.cancel(`meeting_expert_absent:${meetingId}`);
 *
 * with one import, no type error and no lint error — bypassing the absent route entirely.
 * `WebSchedulableNotificationEvent` does not govern that path: it lives in `apps/api` and
 * only constrains a (still unbuilt) HTTP seam.
 *
 * If this test fails: the scheduling primitive is API-internal. Publish an ordinary domain
 * event from `apps/web` — which it may already do — and schedule or cancel API-side, in the
 * code path that observes the condition-voiding fact. Every such fact (the expert joined,
 * the client joined, the proposal was answered, the messages were read) is something
 * `apps/api` learns server-side, which is why no web-side surface is needed.
 */

/**
 * `apps/web/src`. vitest runs with cwd at the package root (`apps/web`); the root-cwd
 * fallback keeps this working if the suite is launched from the monorepo root. The
 * non-vacuity assertion below fails loudly if this ever resolves wrong.
 */
function resolveSrcDir(): string {
  const fromPackage = path.resolve(process.cwd(), 'src');
  if (existsSync(path.join(fromPackage, 'invariants'))) return fromPackage;
  const fromRoot = path.resolve(process.cwd(), 'apps', 'web', 'src');
  if (existsSync(path.join(fromRoot, 'invariants'))) return fromRoot;
  return fromPackage;
}

const SRC_DIR = resolveSrcDir();

/** This file names the forbidden symbols in prose; it must not flag itself. */
const SELF = 'invariants/scheduled-notifications-api-only.test.ts';

/**
 * The API-internal surface, by symbol. Matching the REPOSITORY name (rather than the
 * `@balo/db` import specifier, which `apps/web` uses legitimately everywhere) is what keeps
 * this precise: it catches a direct call, a re-export, and an aliased import alike.
 */
const FORBIDDEN = [
  'scheduledNotificationsRepository',
  'scheduleNotification',
  'cancelScheduledNotification',
] as const;

/** Recursively collect non-test .ts/.tsx files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

interface Scan {
  readonly scanned: string[];
  readonly violations: string[];
}

function scanWebSources(): Scan {
  const scanned: string[] = [];
  const violations: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    if (rel === SELF) continue;
    scanned.push(rel);
    const raw = readFileSync(file, 'utf8');
    if (FORBIDDEN.some((symbol) => raw.includes(symbol))) {
      violations.push(rel);
    }
  }
  return { scanned, violations };
}

describe('scheduled-notification surface is API-only (BAL-420, ADR-1047 Decision 11)', () => {
  const { scanned, violations } = scanWebSources();

  // Non-vacuity guard: if the walk silently finds nothing, the assertion below passes for
  // the wrong reason.
  it('scans the full apps/web source tree (guards against a vacuous pass)', () => {
    expect(scanned.length).toBeGreaterThan(200);
  });

  it('no apps/web file references the scheduled-notification repository or its wrappers', () => {
    expect(
      violations,
      `These apps/web files reach the BAL-420 scheduling primitive, which is API-internal ` +
        `by ADR-1047 Decisions 10 and 11 — cancel is a suppression primitive against Balo's ` +
        `own alerting (it can silence an expert-absent alert) and gets no web-reachable ` +
        `surface, ever. Publish an ordinary domain event instead and schedule/cancel ` +
        `API-side, from the code path that observes the voiding fact:\n  ` +
        `${violations.join('\n  ')}`
    ).toEqual([]);
  });
});
