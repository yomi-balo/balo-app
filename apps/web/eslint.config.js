import { nextJsConfig } from '@repo/eslint-config/next-js';

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  { ignores: ['src/lib/help/generated/**'] },
  {
    files: ['*.config.js', '*.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
];
