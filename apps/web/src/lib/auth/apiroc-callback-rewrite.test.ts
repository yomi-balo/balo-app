import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../../next.config.js';
import { isPublicRoute } from './route-config';

const CALLBACK_PATH = '/auth/apiroc/callback';

async function rewrites(): Promise<unknown> {
  if (!nextConfig.rewrites) throw new Error('next.config.js has no rewrites()');
  return nextConfig.rewrites();
}

describe('Apiroc OAuth callback rewrite (next.config.js)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('proxies the callback path, query string included, to apps/api', async () => {
    vi.stubEnv('API_URL', 'https://balo-app-production.up.railway.app');

    expect(await rewrites()).toEqual([
      {
        source: CALLBACK_PATH,
        destination: `https://balo-app-production.up.railway.app${CALLBACK_PATH}`,
      },
    ]);
  });

  it('does not double the slash when API_URL ends with one', async () => {
    vi.stubEnv('API_URL', 'https://api.example.test/');

    expect(await rewrites()).toEqual([
      { source: CALLBACK_PATH, destination: `https://api.example.test${CALLBACK_PATH}` },
    ]);
  });

  it('adds no rewrite when API_URL is unset', async () => {
    vi.stubEnv('API_URL', '');

    expect(await rewrites()).toEqual([]);
  });

  it('is reachable without a session, so middleware never bounces the vendor redirect to /login', () => {
    expect(isPublicRoute(CALLBACK_PATH)).toBe(true);
  });

  it('targets the path apps/api actually serves', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const apiRoute = readFileSync(
      join(here, '../../../../api/src/routes/calendar/auth.ts'),
      'utf8'
    );

    expect(apiRoute).toContain(`fastify.get('${CALLBACK_PATH}'`);
  });
});
