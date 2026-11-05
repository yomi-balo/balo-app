import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_SOURCE_FILES,
  SRC_DIR,
  codeLines,
  collectSourceFiles,
  readRaw,
} from './_source-scan.js';

/**
 * INVARIANT — the Daily cutover's ops modules are reachable from `apps/api/scripts/` only.
 *
 *   1. `services/daily/webhook-subscription` — registering or rotating the Daily webhook is a
 *      per-environment ops step (daily-co SKILL.md); application code must never create or modify
 *      a subscription. The script lives under `apps/api/scripts/`, outside `src`, so any importer
 *      inside `src` is a violation.
 *   2. `services/meetings/venue-reprovision` — the destructive half of the forced re-provision.
 *      No non-test file outside `apps/api/scripts/` may import it (any app or package).
 *   3. `meetingsRepository.clearScheduledVenuesOnDomain` — the write that nulls venues. It may be
 *      named only inside `packages/db/src/repositories/` and the venue-reprovision service; the
 *      script reaches it through the service, never directly.
 *
 * No regex over source text (S5852): a plain substring scan over non-comment lines.
 */
const MODULE = 'webhook-subscription';
const OWN_FILE = 'services/daily/webhook-subscription.ts';

function importsSubscription(source: string): boolean {
  return codeLines(source)
    .split('\n')
    .some((line) => line.includes(MODULE) && (line.includes('import') || line.includes('from')));
}

describe('the Daily webhook subscription module is script-only', () => {
  it('is imported by no non-test file under apps/api/src', () => {
    const offenders = ALL_SOURCE_FILES.filter(
      (rel) => rel !== OWN_FILE && importsSubscription(readRaw(rel))
    );
    expect(offenders).toEqual([]);
  });

  it('scans a real source surface that includes the module itself', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(100);
    expect(ALL_SOURCE_FILES).toContain(OWN_FILE);
  });

  it('positive control — importsSubscription flags an import and ignores comments and other modules', () => {
    expect(importsSubscription("import { x } from './webhook-subscription.js';")).toBe(true);
    expect(importsSubscription("const m = await import('./webhook-subscription.js');")).toBe(true);
    expect(importsSubscription("// import { x } from './webhook-subscription.js';")).toBe(false);
    expect(importsSubscription("import { x } from './webhook-signature.js';")).toBe(false);
  });
});

const REPROVISION_MODULE = 'venue-reprovision';
const REPROVISION_SERVICE = 'apps/api/src/services/meetings/venue-reprovision.ts';
const REPROVISION_SCRIPT = 'apps/api/scripts/daily-venue-reprovision.ts';
const REPROVISION_SCRIPT_DIR = 'apps/api/scripts/';
const CLEAR_SYMBOL = 'clearScheduledVenuesOnDomain';
const CLEAR_ALLOWED_DIR = 'packages/db/src/repositories/';

interface SourceFile {
  readonly rel: string;
  readonly source: string;
}

/** Every non-test source file under `apps/*` and `packages/*` `src` and `scripts`, repo-relative. */
function collectRepoSources(): SourceFile[] {
  const repoRoot = path.resolve(SRC_DIR, '..', '..', '..');
  const files: SourceFile[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(repoRoot, group);
    for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const sub of ['src', 'scripts']) {
        const dir = path.join(groupDir, pkg.name, sub);
        if (!existsSync(dir)) continue;
        for (const rel of collectSourceFiles(dir, `${group}/${pkg.name}/${sub}`)) {
          files.push({ rel, source: readFileSync(path.join(repoRoot, rel), 'utf8') });
        }
      }
    }
  }
  return files;
}

const REPO_SOURCES = collectRepoSources();

function importsReprovisionService(source: string): boolean {
  return codeLines(source)
    .split('\n')
    .some(
      (line) =>
        line.includes(REPROVISION_MODULE) && (line.includes('import') || line.includes('from'))
    );
}

function namesClearWrite(source: string): boolean {
  return codeLines(source).includes(CLEAR_SYMBOL);
}

function reprovisionImportOffenders(files: readonly SourceFile[]): string[] {
  return files
    .filter(
      ({ rel, source }) =>
        rel !== REPROVISION_SERVICE &&
        !rel.startsWith(REPROVISION_SCRIPT_DIR) &&
        importsReprovisionService(source)
    )
    .map(({ rel }) => rel);
}

function clearWriteOffenders(files: readonly SourceFile[]): string[] {
  return files
    .filter(
      ({ rel, source }) =>
        rel !== REPROVISION_SERVICE && !rel.startsWith(CLEAR_ALLOWED_DIR) && namesClearWrite(source)
    )
    .map(({ rel }) => rel);
}

describe('the venue re-provision service is script-only', () => {
  it('is imported by no non-test file outside apps/api/scripts', () => {
    expect(reprovisionImportOffenders(REPO_SOURCES)).toEqual([]);
  });

  it('names clearScheduledVenuesOnDomain only in the repository layer and the service', () => {
    expect(clearWriteOffenders(REPO_SOURCES)).toEqual([]);
  });

  it('scans a real source surface that includes the files the rules are about', () => {
    const rels = REPO_SOURCES.map(({ rel }) => rel);
    expect(rels.length).toBeGreaterThan(500);
    expect(rels).toContain(REPROVISION_SERVICE);
    expect(rels).toContain(REPROVISION_SCRIPT);
    expect(rels).toContain('packages/db/src/repositories/meetings.ts');
    expect(rels.some((rel) => rel.startsWith('apps/web/src/'))).toBe(true);
  });

  it('positive control — the real script, the permitted importer, matches the import rule', () => {
    const script = REPO_SOURCES.find(({ rel }) => rel === REPROVISION_SCRIPT);
    expect(script).toBeDefined();
    expect(importsReprovisionService(script?.source ?? '')).toBe(true);
  });

  it('positive control — an importer outside scripts is flagged, in any app or package', () => {
    const source = "import { runVenueReprovision } from './venue-reprovision.js';";
    const offenders = reprovisionImportOffenders([
      { rel: 'apps/api/src/routes/ops.ts', source },
      { rel: 'apps/web/src/lib/ops.ts', source },
      { rel: 'packages/shared/src/ops.ts', source },
      { rel: REPROVISION_SCRIPT, source },
      { rel: REPROVISION_SERVICE, source },
    ]);
    expect(offenders).toEqual([
      'apps/api/src/routes/ops.ts',
      'apps/web/src/lib/ops.ts',
      'packages/shared/src/ops.ts',
    ]);
  });

  it('positive control — importsReprovisionService ignores comments and unrelated modules', () => {
    expect(importsReprovisionService("const m = await import('./venue-reprovision.js');")).toBe(
      true
    );
    expect(importsReprovisionService("// import { x } from './venue-reprovision.js';")).toBe(false);
    expect(importsReprovisionService("import { x } from './venue-repair-schedule.js';")).toBe(
      false
    );
  });

  it('positive control — the clear write is flagged anywhere but the repository layer and the service', () => {
    const source = 'await meetingsRepository.clearScheduledVenuesOnDomain(input);';
    const offenders = clearWriteOffenders([
      { rel: REPROVISION_SCRIPT, source },
      { rel: 'apps/api/src/routes/ops.ts', source },
      { rel: 'apps/web/src/lib/actions/ops.ts', source },
      { rel: 'packages/db/src/repositories/meetings.ts', source },
      { rel: REPROVISION_SERVICE, source },
    ]);
    expect(offenders).toEqual([
      REPROVISION_SCRIPT,
      'apps/api/src/routes/ops.ts',
      'apps/web/src/lib/actions/ops.ts',
    ]);
  });

  it('positive control — namesClearWrite ignores comments', () => {
    expect(namesClearWrite('// clearScheduledVenuesOnDomain nulls the venue')).toBe(false);
    expect(namesClearWrite(' * see clearScheduledVenuesOnDomain')).toBe(false);
    expect(namesClearWrite('repo.clearScheduledVenuesOnDomain(x)')).toBe(true);
  });
});
