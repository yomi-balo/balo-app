import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

/**
 * Standalone SonarJS lint config — the maintainability rules SonarCloud enforces
 * on NEW code, runnable locally (pre-PR) so they stop only surfacing server-side
 * after a push.
 *
 * Deliberately NOT wired into the gating `base` / `next-js` configs: the repo has
 * pre-existing violations of these rules, so a hard repo-wide gate would break
 * `pnpm lint`. Run it DIFF-SCOPED instead (a local proxy for SonarCloud's
 * new-code gate):
 *   pnpm lint:sonar:diff   — only files changed vs origin/main (used by pre-PR)
 *   pnpm lint:sonar        — the whole repo, informational
 *
 * All three rules are syntactic, so no TypeScript type information
 * (parserOptions.project) is required — the bare `@typescript-eslint/parser` is
 * enough to parse TS/TSX.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    // This config enables only a few rules, so `eslint-disable` directives for
    // any OTHER rule (e.g. no-control-regex) look "unused" here — don't report them.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      sonarjs,
    },
    rules: {
      // Matches SonarCloud's default cognitive-complexity threshold (15).
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-nested-conditional': 'error',
    },
  },
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'],
  },
];
