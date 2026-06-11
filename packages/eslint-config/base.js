import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import turboPlugin from 'eslint-plugin-turbo';
import regexpPlugin from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';
import onlyWarn from 'eslint-plugin-only-warn';

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      'turbo/no-undeclared-env-vars': 'warn',
    },
  },
  {
    // ReDoS / super-linear regex guard. Catches the SonarCloud S5852 class
    // (e.g. the tag-strip `/<[^>]*>/g` — fix `/<[^<>]*>/g` — and nested
    // quantifiers like `(a+)+`) at `pnpm lint`, before the SonarCloud PR gate.
    plugins: {
      regexp: regexpPlugin,
    },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: ['dist/**'],
  },
];
