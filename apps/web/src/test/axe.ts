import { expect } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

// Only a11y suites import this module, so only they pay the axe-core load. Importing it registers
// the `toHaveNoViolations` matcher (typed ambiently via `@types/jest-axe`).
expect.extend(toHaveNoViolations);

export { axe };
