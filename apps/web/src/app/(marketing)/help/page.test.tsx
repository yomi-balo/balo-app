import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import type { HelpGuide } from '@/lib/help/types';

const { mockGetCurrentUser, fixtureHolder } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  fixtureHolder: { guides: [] as HelpGuide[] },
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/help/content', async () => {
  const actual = await vi.importActual<typeof import('@/lib/help/content')>('@/lib/help/content');
  return {
    ...actual,
    helpContent: {
      listCategories: (audience: 'client' | 'expert') =>
        actual.createHelpContent(fixtureHolder.guides).listCategories(audience),
      findGuide: vi.fn(),
      findSummaries: vi.fn(),
    },
  };
});

import HelpIndexPage from './page';

function guide(overrides: Partial<HelpGuide> & Pick<HelpGuide, 'slug'>): HelpGuide {
  return {
    title: overrides.slug,
    summary: `About ${overrides.slug}`,
    audience: ['client'],
    category: { client: 'calls' },
    order: 1,
    updated: '2026-10-17',
    related: [],
    intro: [],
    sections: [],
    ...overrides,
  };
}

function user(type: 'expert' | 'company' | undefined): SessionUser {
  return { id: 'u1', activeWorkspace: type === undefined ? undefined : { type } } as SessionUser;
}

async function renderPage(
  params: Record<string, string | string[] | undefined> = {}
): Promise<void> {
  render(await HelpIndexPage({ searchParams: Promise.resolve(params) }));
}

function selectedTab(): string {
  return screen.getByRole('tab', { selected: true }).id;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(null);
  fixtureHolder.guides = [
    guide({ slug: 'client-guide', title: 'Client guide' }),
    guide({
      slug: 'expert-guide',
      title: 'Expert guide',
      audience: ['expert'],
      category: { expert: 'getting-paid' },
    }),
  ];
});

describe('HelpIndexPage', () => {
  it('defaults a signed-out visitor to clients', async () => {
    await renderPage();

    expect(selectedTab()).toBe('help-tab-client');
    expect(screen.getByRole('link', { name: /Client guide/ })).toBeInTheDocument();
  });

  it('defaults an expert workspace to the expert side', async () => {
    mockGetCurrentUser.mockResolvedValue(user('expert'));
    await renderPage();

    expect(selectedTab()).toBe('help-tab-expert');
  });

  it('defaults a company workspace, or a missing one, to clients', async () => {
    mockGetCurrentUser.mockResolvedValue(user('company'));
    await renderPage();
    expect(selectedTab()).toBe('help-tab-client');
  });

  it('reads a missing workspace as clients', async () => {
    mockGetCurrentUser.mockResolvedValue(user(undefined));
    await renderPage();

    expect(selectedTab()).toBe('help-tab-client');
  });

  it('lets ?for= beat the workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(user('company'));
    await renderPage({ for: 'experts' });

    expect(selectedTab()).toBe('help-tab-expert');
  });

  it('ignores a bad ?for= and falls back to the default', async () => {
    mockGetCurrentUser.mockResolvedValue(user('expert'));
    await renderPage({ for: 'nope' });

    expect(selectedTab()).toBe('help-tab-expert');
  });

  it('fails open to clients and warns when the session read throws', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('cookie missing'));
    await renderPage();

    expect(selectedTab()).toBe('help-tab-client');
    expect(log.warn).toHaveBeenCalledWith(
      'Help index session read failed; defaulting to clients',
      expect.objectContaining({ error: 'cookie missing' })
    );
  });

  it('tracks INDEX_VIEWED signed out and signed in', async () => {
    await renderPage();
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.INDEX_VIEWED, {
      audience: 'client',
      signed_in: false,
    });

    cleanup();
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(user('expert'));
    await renderPage();
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.INDEX_VIEWED, {
      audience: 'expert',
      signed_in: true,
    });
  });

  it('shows the invitation state when nothing is published', async () => {
    fixtureHolder.guides = [];
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Need a hand with Balo?' })).toBeInTheDocument();
  });
});
