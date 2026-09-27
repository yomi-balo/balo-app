import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { isPublicRoute } from '@/lib/auth/route-config';
import HowItWorksPage, { metadata as howItWorksMetadata } from './how-it-works/page';
import ForExpertsPage, { metadata as forExpertsMetadata } from './for-experts/page';
import PricingPage, { metadata as pricingMetadata } from './pricing/page';

const PAGES = [
  { path: '/how-it-works', title: 'How it works', Page: HowItWorksPage, meta: howItWorksMetadata },
  { path: '/for-experts', title: 'For experts', Page: ForExpertsPage, meta: forExpertsMetadata },
  { path: '/pricing', title: 'Pricing', Page: PricingPage, meta: pricingMetadata },
] as const;

describe.each(PAGES)('$path placeholder', ({ path, title, Page, meta }) => {
  it('is reachable signed out', () => {
    expect(isPublicRoute(path)).toBe(true);
  });

  it('renders one "coming soon" heading and a way back home', () => {
    render(<Page />);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('is kept out of search results', () => {
    expect(meta.robots).toEqual({ index: false });
  });
});

describe('placeholder CTAs', () => {
  it('How it works and Pricing offer Find an expert', () => {
    for (const Page of [HowItWorksPage, PricingPage]) {
      const { unmount } = render(<Page />);
      expect(screen.getByRole('link', { name: 'Find an expert' })).toHaveAttribute(
        'href',
        '/experts'
      );
      unmount();
    }
  });

  it('For experts offers no client CTA and never links to the expert application', () => {
    render(<ForExpertsPage />);
    expect(screen.queryByRole('link', { name: 'Find an expert' })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toMatch(/^\/expert\/apply/);
    }
  });
});
