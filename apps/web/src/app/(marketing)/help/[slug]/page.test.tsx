import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import type { HelpGuide } from '@/lib/help/types';

const { notFoundMock, holder } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  holder: { guides: [] as HelpGuide[] },
}));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/help/content', async () => {
  const actual = await vi.importActual<typeof import('@/lib/help/content')>('@/lib/help/content');
  const current = (): ReturnType<typeof actual.createHelpContent> =>
    actual.createHelpContent(holder.guides);
  return {
    ...actual,
    helpContent: {
      listCategories: (audience: 'client' | 'expert') => current().listCategories(audience),
      findGuide: (slug: string) => current().findGuide(slug),
      findSummaries: (slugs: readonly string[]) => current().findSummaries(slugs),
    },
  };
});

import HelpGuidePage, { generateMetadata } from './page';

function guide(overrides: Partial<HelpGuide> & Pick<HelpGuide, 'slug'>): HelpGuide {
  return {
    title: `Title ${overrides.slug}`,
    summary: `Summary ${overrides.slug}`,
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

const main = guide({
  slug: 'main',
  title: 'Booking a call',
  audience: ['client', 'expert'],
  category: { client: 'calls', expert: 'calls-cases' },
  related: ['other', 'missing'],
  intro: [{ kind: 'html', html: '<p>Intro text</p>' }],
  sections: [
    {
      n: 1,
      title: 'Open the profile',
      blocks: [{ kind: 'html', html: '<p>Step one body</p>' }],
      screenshot: null,
    },
    {
      n: 2,
      title: 'Pick a time',
      blocks: [
        { kind: 'html', html: '<p>Step two body</p>' },
        { kind: 'callout', html: '<p>Mind the timezone</p>' },
      ],
      screenshot: {
        alt: 'Slots shown',
        lightSrc: '/help/main/02-light.png',
        darkSrc: '/help/main/02-dark.png',
      },
    },
  ],
});

const other = guide({ slug: 'other', title: 'Other guide', audience: ['client'] });

async function renderGuide(
  slug: string,
  query: Record<string, string | string[] | undefined> = {}
): Promise<void> {
  render(
    await HelpGuidePage({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve(query),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.guides = [main, other];
});

describe('HelpGuidePage', () => {
  it('calls notFound for an unknown or unpublished slug', async () => {
    await expect(renderGuide('nope')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('renders the title as h1 and numbered sections with headings and anchors', async () => {
    await renderGuide('main');

    expect(screen.getByRole('heading', { level: 1, name: 'Booking a call' })).toBeInTheDocument();
    const second = document.getElementById('step-2');
    expect(second?.tagName).toBe('SECTION');
    expect(second).toHaveAttribute('aria-labelledby', 'step-2-title');
    expect(document.getElementById('step-2-title')).toHaveTextContent('Section 2: Pick a time');
    expect(screen.getByText('Intro text')).toBeInTheDocument();
    expect(screen.getByText('Step one body')).toBeInTheDocument();
  });

  it('renders the callout and a light/dark picture with alt text', async () => {
    await renderGuide('main');

    expect(screen.getByText('Good to know')).toBeInTheDocument();
    expect(screen.getByText('Mind the timezone')).toBeInTheDocument();
    const img = screen.getByRole('img', { name: 'Slots shown' });
    expect(img).toHaveAttribute('src', '/help/main/02-light.png');
    const source = img.closest('picture')?.querySelector('source');
    expect(source).toHaveAttribute('media', '(prefers-color-scheme: dark)');
    expect(source).toHaveAttribute('srcset', '/help/main/02-dark.png');
  });

  it('builds the breadcrumb from the first audience when no side is requested', async () => {
    await renderGuide('main');

    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
    expect(crumbs.getByRole('link', { name: 'For clients' })).toHaveAttribute(
      'href',
      '/help?for=clients'
    );
    expect(crumbs.getByRole('link', { name: 'Consultations and calls' })).toHaveAttribute(
      'href',
      '/help?for=clients#topic-calls'
    );
  });

  it('follows ?for=experts for a guide written for both sides', async () => {
    await renderGuide('main', { for: 'experts' });

    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'For experts' })).toBeInTheDocument();
    expect(crumbs.getByRole('link', { name: 'Calls and cases' })).toHaveAttribute(
      'href',
      '/help?for=experts#topic-calls-cases'
    );
  });

  it('falls back to the guide’s own side when ?for= names a side it lacks', async () => {
    holder.guides = [other];
    await renderGuide('other', { for: 'experts' });

    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'For clients',
      })
    ).toBeInTheDocument();
  });

  it('lists related guides, dropping unknown slugs, with the related source', async () => {
    await renderGuide('main');

    const related = screen.getByRole('region', { name: 'Related guides' });
    const links = within(related).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/help/other?for=clients&src=related');
  });

  it('tracks the article view with the related source from ?src=related', async () => {
    await renderGuide('main', { src: 'related' });

    expect(track).toHaveBeenCalledWith(HELP_EVENTS.ARTICLE_VIEWED, {
      slug: 'main',
      audience: 'client',
      source: 'related',
    });
  });

  it('tracks the external source when there is no src', async () => {
    await renderGuide('main');

    expect(track).toHaveBeenCalledWith(
      HELP_EVENTS.ARTICLE_VIEWED,
      expect.objectContaining({ source: 'external' })
    );
  });

  it('hides Related guides when none resolve', async () => {
    holder.guides = [{ ...main, related: ['missing'] }];
    await renderGuide('main');

    expect(screen.queryByRole('heading', { name: 'Related guides' })).not.toBeInTheDocument();
  });

  it('omits the side from a related link when the target is not written for it', async () => {
    holder.guides = [
      { ...main, related: ['expert-only'] },
      guide({ slug: 'expert-only', audience: ['expert'], category: { expert: 'projects' } }),
    ];
    await renderGuide('main');

    expect(
      within(screen.getByRole('region', { name: 'Related guides' })).getByRole('link')
    ).toHaveAttribute('href', '/help/expert-only?src=related');
  });

  it('shows no rail or jump list for a guide without sections', async () => {
    holder.guides = [{ ...main, sections: [], related: [] }];
    await renderGuide('main');

    expect(
      screen.queryByRole('navigation', { name: 'Sections in this guide' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /In this guide/ })).not.toBeInTheDocument();
    expect(screen.getByText('Intro text')).toBeInTheDocument();
  });

  it('includes the date, feedback prompt and support block', async () => {
    await renderGuide('main');

    expect(screen.getByText('17 October 2026')).toHaveAttribute('datetime', '2026-10-17');
    expect(screen.getByText('Did this guide help?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email support' })).toBeInTheDocument();
  });
});

describe('generateMetadata', () => {
  it('titles the page from the guide', async () => {
    expect(await generateMetadata({ params: Promise.resolve({ slug: 'main' }) })).toEqual({
      title: 'Booking a call — Balo help',
      description: 'Summary main',
    });
  });

  it('returns nothing for an unknown guide', async () => {
    expect(await generateMetadata({ params: Promise.resolve({ slug: 'nope' }) })).toEqual({});
  });
});
