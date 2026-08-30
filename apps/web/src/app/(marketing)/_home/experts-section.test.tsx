import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import type { ExpertCardData } from '@/components/expert/expert-card.types';
import { ExpertsSection } from './experts-section';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// `SpotlightGrid` renders the real `ExpertCard` — stubbed here (same pattern as
// `search-result-card.test.tsx`) so this file tests ExpertsSection's OWN layout/state decision
// (which grid class, which branch renders) rather than ExpertCard's internals.
vi.mock('@/components/expert', () => ({
  ExpertCard: ({ expert }: { expert: { name: string } }) => (
    <div data-testid="expert-card">{expert.name}</div>
  ),
}));

function makeExpert(overrides: Partial<ExpertCardData> = {}): ExpertCardData {
  return {
    id: 'e1',
    username: 'anil',
    name: 'Anil Pilania',
    initials: 'AP',
    avatarUrl: null,
    headline: null,
    bio: null,
    countryCode: null,
    rate: null,
    nextAvailableAt: null,
    languages: [],
    agency: null,
    distinctions: { isSalesforceMvp: false, isSalesforceCta: false, isCertifiedTrainer: false },
    rating: null,
    ratingCount: 0,
    yearsExperience: null,
    consultationCount: 0,
    expertise: [],
    ...overrides,
  };
}

describe('ExpertsSection — the 0-card state (the SHIPPED DEFAULT, §8.4)', () => {
  it('renders the vetting strip + an invitation CTA to /experts, and is never framed by absence', () => {
    const { container } = render(<ExpertsSection experts={[]} expertTotal={128} />);

    expect(container.textContent).not.toContain('No ');
    expect(container.querySelector('.mk-experts')).toBeNull();
    expect(container.querySelector('.mk-xc-invite')).not.toBeNull();

    const cta = screen.getByRole('link', { name: 'Browse every vetted expert' });
    expect(cta).toHaveAttribute('href', '/experts');
    expect(cta.className).toContain('mk-btn-grad');

    expect(screen.getByText('128 Salesforce experts are on Balo right now.')).toBeInTheDocument();
  });

  it('degrades the sub-line honestly (and still never "No ") when expertTotal is unknown', () => {
    render(<ExpertsSection experts={[]} expertTotal={null} />);
    expect(screen.getByText('New Salesforce experts join Balo every week.')).toBeInTheDocument();
  });

  it('has no accessibility violations in the 0-card default', async () => {
    const { container } = render(<ExpertsSection experts={[]} expertTotal={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ExpertsSection — the 1/2/3-card states render through SpotlightGrid (§8.3/§8.4)', () => {
  it('1 card: single centred layout (.mk-experts.mk-experts--1), no invitation panel', () => {
    const { container } = render(
      <ExpertsSection experts={[makeExpert({ id: 'e1' })]} expertTotal={5} />
    );
    const grid = container.querySelector('.mk-experts');
    if (!grid) throw new Error('expected .mk-experts to render');
    expect(grid.classList.contains('mk-experts--1')).toBe(true);
    expect(grid.classList.contains('mk-experts--2')).toBe(false);
    expect(container.querySelector('.mk-xc-invite')).toBeNull();
    expect(screen.getAllByTestId('expert-card')).toHaveLength(1);
  });

  it('2 cards: centred 2-col layout (.mk-experts.mk-experts--2)', () => {
    const { container } = render(
      <ExpertsSection
        experts={[makeExpert({ id: 'e1' }), makeExpert({ id: 'e2', name: 'Dana Okafor' })]}
        expertTotal={5}
      />
    );
    const grid = container.querySelector('.mk-experts');
    if (!grid) throw new Error('expected .mk-experts to render');
    expect(grid.classList.contains('mk-experts--2')).toBe(true);
    expect(grid.classList.contains('mk-experts--1')).toBe(false);
    expect(screen.getAllByTestId('expert-card')).toHaveLength(2);
  });

  it('3 cards: the base grid, no count modifier', () => {
    const { container } = render(
      <ExpertsSection
        experts={[
          makeExpert({ id: 'e1' }),
          makeExpert({ id: 'e2', name: 'Dana Okafor' }),
          makeExpert({ id: 'e3', name: 'Sam Whitaker' }),
        ]}
        expertTotal={5}
      />
    );
    const grid = container.querySelector('.mk-experts');
    if (!grid) throw new Error('expected .mk-experts to render');
    expect(grid.className.trim()).toBe('mk-experts');
    expect(screen.getAllByTestId('expert-card')).toHaveLength(3);
  });
});

describe('ExpertsSection — content that never depends on card count', () => {
  it('always renders the "Browse all experts" head-link and the 4-item vetting strip', () => {
    for (const experts of [[], [makeExpert()]]) {
      const { unmount } = render(<ExpertsSection experts={experts} expertTotal={1} />);
      expect(screen.getByRole('link', { name: 'Browse all experts' })).toHaveAttribute(
        'href',
        '/experts'
      );
      expect(screen.getByText('Certifications verified')).toBeInTheDocument();
      expect(screen.getByText('Technical interview')).toBeInTheDocument();
      expect(screen.getByText('Live scenario')).toBeInTheDocument();
      expect(screen.getByText('Rated every session')).toBeInTheDocument();
      unmount();
    }
  });
});
