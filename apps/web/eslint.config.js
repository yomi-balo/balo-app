import { nextJsConfig } from '@repo/eslint-config/next-js';

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  { ignores: ['src/lib/help/generated/**'] },
  {
    // BAL-605 — `@/test/axe` registers `toHaveNoViolations` on import, so only a11y suites pay
    // the axe-core load. A direct `jest-axe` import skips that registration.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/test/axe.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'jest-axe', message: "Import `axe` from '@/test/axe' instead." }],
        },
      ],
    },
  },
  {
    files: ['*.config.js', '*.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
];
