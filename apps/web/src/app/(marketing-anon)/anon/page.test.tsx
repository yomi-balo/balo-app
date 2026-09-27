import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { MarketingHomeData } from '@/lib/marketing/load-home-data';
import * as ogImage from '../opengraph-image';
import * as marketingOgImage from '../../(marketing)/opengraph-image';
import { MARKETING_HOME_METADATA } from '../../(marketing)/_home/marketing-home-metadata';
import { metadata as signedInMetadata } from '../../(marketing)/page';
import AnonMarketingHomePage, { metadata, revalidate, dynamic } from './page';

const { mockLoadHomeDataResult, mockLogError } = vi.hoisted(() => ({
  mockLoadHomeDataResult: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/marketing/load-home-data', () => ({
  loadHomeDataResult: mockLoadHomeDataResult,
}));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError, warn: vi.fn(), info: vi.fn() } }));
// `(marketing)/page.tsx` is imported below (unmocked) so the metadata-equivalence test compares
// the SAME module both routes ship — this mock keeps its `@/lib/auth/session` import (which
// starts with `import 'server-only'`) from reaching the real module in this jsdom test.
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/anon',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-auth-modal', () => ({ useAuthModal: () => ({ open: vi.fn() }) }));

function makeHomeData(overrides: Partial<MarketingHomeData> = {}): MarketingHomeData {
  return {
    taxonomy: { groups: [{ id: 'g-ai', name: 'AI', items: [{ id: 'p1', name: 'Agentforce' }] }] },
    productNameMap: { p1: 'Agentforce' },
    chips: [{ id: 'p1', name: 'Agentforce' }],
    benchTiles: [],
    expertTotal: 42,
    wasAvailabilityGated: false,
    spotlight: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadHomeDataResult.mockResolvedValue({ data: makeHomeData(), degraded: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('(marketing-anon)/anon — renders the signed-out hero', () => {
  it('renders exactly one h1', async () => {
    const ui = await AnonMarketingHomePage();
    render(ui);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('mounts the hero search island (no session, no isLoggedIn prop to resolve)', async () => {
    const ui = await AnonMarketingHomePage();
    render(ui);
    expect(screen.getByRole('search')).toBeInTheDocument();
  });
});

describe('(marketing-anon)/anon — segment config', () => {
  it('revalidates every 300s', () => {
    expect(revalidate).toBe(300);
  });

  it('errors rather than going dynamic', () => {
    expect(dynamic).toBe('error');
  });
});

describe('(marketing-anon)/anon — metadata matches (marketing)/', () => {
  it('is the exact same object as the shared metadata module exports', () => {
    expect(metadata).toBe(MARKETING_HOME_METADATA);
  });

  /**
   * Mutation-prove it: give `(marketing)/page.tsx` its own divergent `metadata` export (e.g.
   * `export const metadata: Metadata = { ...MARKETING_HOME_METADATA, title: 'Different' };`) and
   * this fails, because it imports the LIVE export from that file rather than re-checking the
   * shared module against itself.
   */
  it('is the exact same object (marketing)/page.tsx exports as its own metadata', () => {
    expect(signedInMetadata).toBe(metadata);
  });

  it('carries no robots field, on either route', () => {
    expect(metadata.robots).toBeUndefined();
    expect(signedInMetadata.robots).toBeUndefined();
  });
});

describe('(marketing-anon)/opengraph-image — re-exports (marketing)/opengraph-image verbatim', () => {
  it('re-exports the same size, alt and contentType', () => {
    expect(ogImage.size).toEqual(marketingOgImage.size);
    expect(ogImage.alt).toBe(marketingOgImage.alt);
    expect(ogImage.contentType).toBe(marketingOgImage.contentType);
  });

  it('re-exports the same default image renderer', () => {
    expect(ogImage.default).toBe(marketingOgImage.default);
  });
});

describe('(marketing-anon)/anon — the degraded guard', () => {
  it('throws at runtime in production when the data is degraded', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', '');
    mockLoadHomeDataResult.mockResolvedValue({ data: makeHomeData(), degraded: true });

    await expect(AnonMarketingHomePage()).rejects.toThrow(
      'Marketing home data degraded; keeping the last good prerender'
    );
  });

  it('renders degraded data (and only logs) during the production build phase', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    mockLoadHomeDataResult.mockResolvedValue({ data: makeHomeData(), degraded: true });

    const ui = await AnonMarketingHomePage();
    render(ui);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('never throws in development even when degraded', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mockLoadHomeDataResult.mockResolvedValue({ data: makeHomeData(), degraded: true });

    const ui = await AnonMarketingHomePage();
    render(ui);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
