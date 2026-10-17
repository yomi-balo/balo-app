import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { occurrences, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-597 — the help centre's markdown tooling is BUILD-TIME ONLY.
 *
 * `docs/help/*.md` is compiled by a vitest-run generator into a committed TypeScript module
 * (`lib/help/generated/help-guides.generated.ts`), so nothing parses markdown or reads the
 * filesystem at runtime. These assertions hold that line:
 *
 *  1. only `lib/help/compiler/` imports `marked` or `yaml`;
 *  2. nothing outside `lib/help/compiler/` imports the compiler directory;
 *  3. the runtime help code never imports `fs`.
 *
 * If this fails: do NOT add an allow-list entry. Move the code into `lib/help/compiler/` (and keep
 * it test-only), or read the committed module instead.
 */

const SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
];

/** CI runs web vitest from the repo root, a developer from `apps/web` (memory `reference_web_server_disk_asset_cwd`). */
const WEB_SRC =
  ['apps/web/src', 'src']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(path.join(candidate, 'invariants'))) ?? '';

const SCANNED: readonly ScannedFile[] =
  WEB_SRC === '' ? [] : scanRouteSources(WEB_SRC, '', SKIPPED_DIRECTORIES);

const COMPILER_DIR = 'lib/help/compiler/';
const RUNTIME_DIRS: readonly string[] = ['lib/help/', 'app/(marketing)/help/'];

/** Every quoted specifier following a static, dynamic or require import opener. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const opener of ['from ', 'import(', 'require(']) {
    let at = source.indexOf(opener);
    while (at !== -1) {
      const start = at + opener.length;
      const quote = source.charAt(start);
      if (quote === "'" || quote === '"') {
        const end = source.indexOf(quote, start + 1);
        if (end !== -1) found.push(source.slice(start + 1, end));
      }
      at = source.indexOf(opener, at + 1);
    }
  }
  return found;
}

/** Any specifier naming the compiler directory, absolute (`@/lib/help/compiler`) or relative (`../compiler/x`). */
const importsCompiler = (source: string): boolean =>
  specifiersOf(source).some((specifier) => specifier.includes('compiler'));

const isTest = (rel: string): boolean => /\.test\.tsx?$/.test(rel);

/** Whether `source` pulls in `specifier` (or a path under it) by a static, dynamic or require import. */
function importsModule(source: string, specifier: string): boolean {
  for (const quote of ["'", '"']) {
    for (const opener of ['from ', 'import(', 'require(']) {
      const needle = `${opener}${quote}${specifier}`;
      let at = source.indexOf(needle);
      while (at !== -1) {
        const next = source.charAt(at + needle.length);
        if (next === quote || next === '/') return true;
        at = source.indexOf(needle, at + 1);
      }
    }
  }
  return false;
}

const fileFor = (rel: string): ScannedFile | undefined => SCANNED.find((file) => file.rel === rel);

describe('invariant: help markdown tooling is build-time only (BAL-597)', () => {
  it('guards the guard: the scan sees the build parser importing marked and yaml', () => {
    expect(WEB_SRC).not.toBe('');
    const parser = fileFor(`${COMPILER_DIR}parse-guide.ts`);
    expect(parser).toBeDefined();
    expect(importsModule(parser?.code ?? '', 'marked')).toBe(true);
    expect(importsModule(parser?.code ?? '', 'yaml')).toBe(true);
    expect(occurrences(parser?.code ?? '', 'marked')).toBeGreaterThan(0);
  });

  it('guards the guard: the matcher catches every import form it claims to', () => {
    expect(importsModule(`import { Lexer } from 'marked';`, 'marked')).toBe(true);
    expect(importsModule(`import y from "yaml";`, 'yaml')).toBe(true);
    expect(importsModule(`const m = await import('marked');`, 'marked')).toBe(true);
    expect(importsModule(`const m = require('marked');`, 'marked')).toBe(true);
    expect(importsModule(`import x from 'node:fs/promises';`, 'node:fs')).toBe(true);
    expect(importsModule(`import x from 'marked-extra';`, 'marked')).toBe(false);
    expect(importsModule(`// we never import marked`, 'marked')).toBe(false);
  });

  it('guards the guard: the compiler matcher catches absolute and relative specifiers', () => {
    expect(importsCompiler(`import x from '@/lib/help/compiler/validate';`)).toBe(true);
    expect(importsCompiler(`import x from '../compiler/validate';`)).toBe(true);
    expect(importsCompiler(`const x = await import("./compiler/validate");`)).toBe(true);
    expect(importsCompiler(`import x from '../content';`)).toBe(false);
  });

  it('only non-test files under lib/help/compiler/ import marked or yaml', () => {
    const offenders = SCANNED.filter(
      (file) =>
        !file.rel.startsWith(COMPILER_DIR) &&
        (importsModule(file.code, 'marked') || importsModule(file.code, 'yaml'))
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('nothing outside lib/help/compiler/ imports the compiler directory', () => {
    const offenders = SCANNED.filter(
      (file) =>
        !isTest(file.rel) && !file.rel.startsWith(COMPILER_DIR) && importsCompiler(file.code)
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('runtime help code never imports fs', () => {
    const offenders = SCANNED.filter(
      (file) =>
        !isTest(file.rel) &&
        !file.rel.startsWith(COMPILER_DIR) &&
        RUNTIME_DIRS.some((dir) => file.rel.startsWith(dir)) &&
        (importsModule(file.code, 'fs') || importsModule(file.code, 'node:fs'))
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
