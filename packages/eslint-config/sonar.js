import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import react from 'eslint-plugin-react';

/**
 * Standalone SonarJS lint config — the maintainability/reliability rules
 * SonarCloud enforces on NEW code, runnable locally (pre-PR) so they stop only
 * surfacing server-side after a push.
 *
 * Deliberately NOT wired into the gating `base` / `next-js` configs: the repo has
 * pre-existing violations of these rules, so a hard repo-wide gate would break
 * `pnpm lint`. Run it DIFF-SCOPED instead (a local proxy for SonarCloud's
 * new-code gate):
 *   pnpm lint:sonar:diff   — only files changed vs origin/main (used by pre-PR)
 *   pnpm lint:sonar        — the whole repo, informational
 *
 * Each rule mirrors a SonarCloud rule that otherwise only fails server-side after
 * a push (SonarCloud delegates these to the bracketed ESLint rule). When a new
 * SonarCloud finding slips through to CI, add its delegate rule here so the
 * pre-PR `lint:sonar:diff` catches it next time:
 *   sonarjs/cognitive-complexity         — S3776, function cognitive complexity > 15
 *   sonarjs/no-nested-template-literals  — nested template literals
 *   sonarjs/no-nested-conditional        — nested ternaries
 *   sonarjs/reduce-initial-value         — S6959, "Array.reduce()" must pass an initial value
 *   react/no-array-index-key             — S6479, do not use the array index as a React key
 *   unicorn/prefer-global-this           — S7764, prefer `globalThis` over `window`
 *   unicorn/no-negated-condition         — S7735, "Unexpected negated condition" (else branch)
 *
 * All rules are syntactic, so no TypeScript type information
 * (parserOptions.project) is required — the bare parser is enough to parse TS/TSX.
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
    settings: {
      // `no-array-index-key` is version-independent; pin a version only to silence
      // eslint-plugin-react's "React version not specified" notice in this
      // standalone (no react installed alongside) config.
      react: { version: '19' },
    },
    plugins: {
      sonarjs,
      unicorn,
      react,
    },
    rules: {
      // Matches SonarCloud's default cognitive-complexity threshold (15).
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-nested-conditional': 'error',
      'sonarjs/reduce-initial-value': 'error',
      'react/no-array-index-key': 'error',
      'unicorn/prefer-global-this': 'error',
      'unicorn/no-negated-condition': 'error',
    },
  },
  {
    // Mirror SonarCloud's analysis scope: it only scans `sonar.sources`
    // (apps/*/src, packages/*/src), so design-reference scratch files under
    // `.claude/` are never gated server-side — don't let the local proxy flag
    // them either (they are illustrative prototypes, not shipped code).
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/coverage-integration/**',
      '**/.claude/**',
    ],
  },
];
