import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Silence structured logger in tests — all auth actions and server code import this.
// Auto-mock avoids adding vi.mock('@/lib/logging') to every test file.
vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() },
  getContext: vi.fn(),
  withContext: vi.fn(),
  requestContext: {},
}));

// Cleanup after each test
afterEach(() => {
  cleanup();
});
