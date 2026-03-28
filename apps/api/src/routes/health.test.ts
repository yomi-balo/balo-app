import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// phone routes use createRequire(import.meta.url)('@balo/shared/logging') which
// tries to load a CJS package that vitest cannot parse. Mock node:module so the
// module graph resolves cleanly in the test environment.
vi.mock('node:module', () => ({
  createRequire: vi.fn(() => () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  })),
}));

import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe('Health Route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 OK', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
