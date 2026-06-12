#!/usr/bin/env node
/**
 * Run the standalone SonarJS rules (packages/eslint-config/sonar.js) on ONLY the
 * source files changed vs the base branch — a local, diff-scoped proxy for
 * SonarCloud's new-code maintainability gate (cognitive complexity, nested
 * ternaries, nested template literals). Wired into the pre-PR step so these stop
 * only surfacing server-side after a push.
 *
 * Override the base branch with SONAR_BASE (default: origin/main). Exits non-zero
 * when a changed file violates a rule, 0 when clean or nothing relevant changed.
 */
import { execFileSync } from 'node:child_process';

const base = process.env.SONAR_BASE ?? 'origin/main';
const CONFIG = 'packages/eslint-config/sonar.js';
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function diffNames(ref) {
  // `git diff <ref>` (two-dot, against the WORKING TREE) captures committed +
  // staged + unstaged changes — the right scope for a pre-PR check that runs
  // before committing.
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', ref], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => SOURCE.test(f));
}

function changedFiles() {
  try {
    // Everything changed on this branch since it diverged from the base.
    const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return diffNames(mergeBase);
  } catch {
    // Base ref not available locally (e.g. not fetched) — fall back to changes
    // not yet committed (staged + unstaged) against HEAD.
    try {
      return diffNames('HEAD');
    } catch {
      return [];
    }
  }
}

const files = changedFiles();
if (files.length === 0) {
  console.log(`SonarJS: no changed source files vs ${base}.`);
  process.exit(0);
}

console.log(`SonarJS: checking ${files.length} changed file(s) vs ${base}…`);
try {
  execFileSync('pnpm', ['exec', 'eslint', '--config', CONFIG, '--no-config-lookup', ...files], {
    stdio: 'inherit',
  });
  console.log('SonarJS: clean ✓');
} catch {
  console.error(
    '\nSonarJS found maintainability issues in your changed files (these would block the SonarCloud gate). Fix them, or run `pnpm lint:sonar` to see the whole repo.'
  );
  process.exitCode = 1;
}
