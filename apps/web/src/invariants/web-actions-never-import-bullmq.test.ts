import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasUseServerDirective,
  occurrences,
  scanRouteSources,
  type ScannedFile,
} from './_source-scan';

/**
 * BAL-550 — `apps/web` MUST NOT import BullMQ or Redis.
 *
 * The re-drive is a MUTATION that enqueues a job, and the shape it could most easily have taken
 * is a Server Action reaching for `new Queue(...)` directly. That was rejected on the record
 * (PR #273): the queue is reachable only through `POST /admin/redrive/:kind/:id` in `apps/api`,
 * which resolves the actor against the LIVE `users` row before it enqueues anything. A web-side
 * enqueue would put a queue-injection primitive behind whatever the web app happens to believe
 * about the caller, and leave no identity trail on the job.
 *
 * `request-redrive.ts`'s own docblock CITES this file by name as the thing that holds that line
 * — so the invariant has to actually exist, or the comment vouches for an unheld guarantee.
 *
 * Scoped to `apps/web/src` deliberately: `apps/api` imports BullMQ everywhere and legitimately.
 * Both the Server Action arm (what the ticket words the requirement as) and the whole-app arm
 * (what actually keeps the dependency out of the bundle) are asserted, because a non-action
 * module importing the queue would be just as bad and is not covered by the narrower reading.
 *
 * If this test fails: do NOT add an allow-list entry. Route the work through `apps/api` behind
 * the capability check, the way `lib/api/admin-redrive.ts` does.
 */

const SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '__snapshots__',
];

/** The forbidden module specifiers. `ioredis` is BullMQ's transport — banning one without the other leaves the hole open. */
const FORBIDDEN_MODULES: readonly string[] = ['bullmq', 'ioredis'];

/**
 * CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web` — the two-cwd
 * reality `_source-scan.ts`'s `resolveRouteDir` guards against (memory
 * `reference_web_server_disk_asset_cwd`). A walk that resolves to nothing passes every
 * assertion below for the wrong reason, which is what the first "guards the guard" case catches.
 */
const WEB_SRC =
  ['apps/web/src', 'src']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(path.join(candidate, 'invariants'))) ?? '';

const SCANNED: readonly ScannedFile[] =
  WEB_SRC === '' ? [] : scanRouteSources(WEB_SRC, '', SKIPPED_DIRECTORIES);

/**
 * Whether `source` pulls in `specifier` by ANY route — a static `from '…'`, a dynamic
 * `import('…')`, or a CommonJS `require('…')`.
 *
 * `namedImportsFrom` is deliberately NOT reused here: it returns the BINDINGS of a braced
 * import, so a default import (`import Redis from 'ioredis'`) or a namespace import yields `[]`
 * and would read as clean. This asks the presence question instead. Both quote styles are
 * checked literally, per this directory's no-regex convention (SonarCloud S5852).
 */
function importsModule(source: string, specifier: string): boolean {
  for (const quote of ["'", '"']) {
    const q = `${quote}${specifier}${quote}`;
    if (occurrences(source, `from ${q}`) > 0) return true;
    if (occurrences(source, `import(${q})`) > 0) return true;
    if (occurrences(source, `require(${q})`) > 0) return true;
  }
  return false;
}

/** The Server Action module this ticket added — the one whose docblock names this file. */
const REDRIVE_ACTION = 'app/(dashboard)/admin/health/capture/_actions/request-redrive.ts';

describe('invariant: apps/web never imports BullMQ or Redis (BAL-550)', () => {
  it('guards the guard: resolves apps/web/src and scans a non-trivial number of files', () => {
    expect(WEB_SRC).not.toBe('');
    // Non-vacuity: a broken walk would pass every assertion below for the wrong reason.
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED.map((file) => file.rel)).toContain(REDRIVE_ACTION);
  });

  it('guards the guard: the scan finds Server Action modules, including the re-drive one', () => {
    const actions = SCANNED.filter((file) => hasUseServerDirective(file.raw));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.map((file) => file.rel)).toContain(REDRIVE_ACTION);
  });

  it('guards the guard: the matcher catches every import form it claims to', () => {
    expect(importsModule(`import { Queue } from 'bullmq';`, 'bullmq')).toBe(true);
    expect(importsModule(`import Redis from "ioredis";`, 'ioredis')).toBe(true);
    expect(importsModule(`const q = await import('bullmq');`, 'bullmq')).toBe(true);
    expect(importsModule(`const q = require('bullmq');`, 'bullmq')).toBe(true);
    // And does not fire on a lookalike specifier or on the bare word.
    expect(importsModule(`import x from 'bullmq-extra';`, 'bullmq')).toBe(false);
    expect(importsModule(`// we never import bullmq here`, 'bullmq')).toBe(false);
  });

  it('no Server Action in apps/web imports BullMQ or Redis', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      if (!hasUseServerDirective(file.raw)) continue;
      for (const forbidden of FORBIDDEN_MODULES) {
        if (importsModule(file.code, forbidden)) offenders.push(`${file.rel} -> ${forbidden}`);
      }
    }
    expect(
      offenders,
      `These Server Actions import a queue module directly: ${offenders.join(', ')}. ` +
        `Enqueueing from apps/web bypasses the live-user capability check on ` +
        `POST /admin/redrive/:kind/:id and leaves the job with no identity trail — route it ` +
        `through apps/api instead (see lib/api/admin-redrive.ts).`
    ).toEqual([]);
  });

  it('no module anywhere in apps/web imports BullMQ or Redis', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      for (const forbidden of FORBIDDEN_MODULES) {
        if (importsModule(file.code, forbidden)) offenders.push(`${file.rel} -> ${forbidden}`);
      }
    }
    expect(
      offenders,
      `These apps/web modules import a queue module: ${offenders.join(', ')}. ` +
        `apps/web has no queue connection and must not gain one.`
    ).toEqual([]);
  });
});
