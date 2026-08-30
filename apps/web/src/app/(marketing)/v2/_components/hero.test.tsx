import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen } from '@/test/utils';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { VERTICAL } from '../_lib/content';
import { toV2Taxonomy, type V2Taxonomy } from '../_lib/product-facet-model';
import { Hero } from './hero';
import { MotionCtx, usePrefersReduced } from './motion';

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// jsdom has no `matchMedia`; the repo's convention (see `use-eased-number.test.tsx`) is a
// small local stub rather than editing the shared `apps/web/src/test/setup.ts` for a
// temporary preview page.
function stubPrefersReducedMotion(matches: boolean): void {
  globalThis.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof globalThis.matchMedia;
}

const originalMatchMedia = globalThis.matchMedia;

beforeEach(() => {
  mockPush.mockClear();
  stubPrefersReducedMotion(false);
});

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
});

// ── Fixtures ────────────────────────────────────────────────────

const HERO_TAXONOMY: V2Taxonomy = {
  source: 'live',
  groups: [
    {
      group: 'Sales',
      items: [
        { id: 'id-sales-cloud', name: 'Sales Cloud' },
        { id: 'id-cpq', name: 'CPQ' },
      ],
    },
    {
      // > DENSE_CAP (4) items — exercises the "+n more" reveal.
      group: 'Dense Group',
      items: [
        { id: 'id-1', name: 'Alpha' },
        { id: 'id-2', name: 'Beta' },
        { id: 'id-3', name: 'Gamma' },
        { id: 'id-4', name: 'Delta' },
        { id: 'id-5', name: 'Epsilon' },
      ],
    },
  ],
};

const FALLBACK_TAXONOMY_V2 = toV2Taxonomy(EMPTY_TAXONOMY);

const FTS_LABEL = `Describe what you need help with in ${VERTICAL.name}`;

/** Mirrors the real composition in `marketing-home-v2.tsx`: `usePrefersReduced()` feeds
 * `MotionCtx`, which `Hero` reads via `useReduced()`. Hero itself never calls
 * `usePrefersReduced` directly, so the reduced-motion test needs this harness to exercise
 * the same wiring production uses. */
function ReducedMotionHarness({ taxonomy }: Readonly<{ taxonomy: V2Taxonomy }>): React.JSX.Element {
  const reduced = usePrefersReduced();
  return (
    <MotionCtx.Provider value={reduced}>
      <Hero taxonomy={taxonomy} />
    </MotionCtx.Provider>
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe('Hero', () => {
  it('renders the FTS input and the facet trigger showing Product / Any', () => {
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    expect(screen.getByLabelText(FTS_LABEL)).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /product/i });
    expect(trigger).toHaveTextContent('Product');
    expect(trigger).toHaveTextContent('Any');
  });

  it('submitting the form (the Enter path) pushes /experts?q=… with no products', () => {
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    fireEvent.change(screen.getByLabelText(FTS_LABEL), {
      target: { value: 'flow debugging' },
    });
    fireEvent.submit(screen.getByRole('search'));

    expect(mockPush).toHaveBeenCalledWith('/experts?q=flow+debugging');
  });

  it('submitting with no q and no products pushes bare /experts', () => {
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    fireEvent.submit(screen.getByRole('search'));

    expect(mockPush).toHaveBeenCalledWith('/experts');
  });

  it('facet interaction: selecting a chip updates the badge and summary, and submit emits products=<uuid>', async () => {
    const user = userEvent.setup();
    const { container } = render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));
    await user.click(screen.getByRole('button', { name: 'Sales Cloud' }));

    expect(container.querySelector('.mk2-facet-badge')).toHaveTextContent('1');
    expect(container.querySelector('.mk2-facet-val')).toHaveTextContent('Sales Cloud');

    fireEvent.submit(screen.getByRole('search'));
    expect(mockPush).toHaveBeenCalledWith('/experts?products=id-sales-cloud');
  });

  it('two selected chips emit two repeated products= params, in selection order', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));
    await user.click(screen.getByRole('button', { name: 'Sales Cloud' }));
    await user.click(screen.getByRole('button', { name: 'CPQ' }));

    fireEvent.submit(screen.getByRole('search'));
    expect(mockPush).toHaveBeenCalledWith('/experts?products=id-sales-cloud&products=id-cpq');
  });

  // Degraded mode. Every fallback item's `id` is null, so `selectedProductIds()` can emit
  // nothing and a product filter physically cannot reach the URL. The facet is therefore
  // INERT — the earlier build let the popover open, chips highlight and the badge count while
  // submit silently discarded the lot, which is a filter that looks applied and is not.
  it('fallback taxonomy: the facet is inert and says so, and submit emits q only', async () => {
    const user = userEvent.setup();
    const { container } = render(<Hero taxonomy={FALLBACK_TAXONOMY_V2} />);

    fireEvent.change(screen.getByLabelText(FTS_LABEL), {
      target: { value: 'stuck on a flow' },
    });

    const trigger = screen.getByRole('button', { name: /product/i });
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveTextContent('Unavailable');

    // The popover cannot be opened, so no chip and no badge can ever appear.
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agentforce' })).not.toBeInTheDocument();
    expect(container.querySelector('.mk2-facet-badge')).toBeNull();

    // The FTS half still works — degradation is scoped to the product filter.
    fireEvent.submit(screen.getByRole('search'));
    expect(mockPush).toHaveBeenCalledWith('/experts?q=stuck+on+a+flow');
  });

  it('live taxonomy: the facet is NOT disabled (proves the inert case is a real branch)', () => {
    render(<Hero taxonomy={HERO_TAXONOMY} />);
    const trigger = screen.getByRole('button', { name: /product/i });
    expect(trigger).not.toHaveAttribute('aria-disabled');
    expect(trigger).not.toHaveTextContent('Unavailable');
  });

  it('Escape closes the popover', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a mousedown outside the search form closes the popover', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"+n more" on a dense group reveals the remaining chips', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));

    expect(screen.queryByRole('button', { name: 'Epsilon' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+1 more' }));
    expect(screen.getByRole('button', { name: 'Epsilon' })).toBeInTheDocument();
  });

  it('Enter inside the popover product-search input does not submit the outer form', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.click(screen.getByRole('button', { name: /product/i }));
    await user.type(screen.getByLabelText('Search products'), 'cloud{Enter}');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('control: Enter in the main FTS input DOES submit (proves the popover case is a real guard)', async () => {
    const user = userEvent.setup();
    render(<Hero taxonomy={HERO_TAXONOMY} />);

    await user.type(screen.getByLabelText(FTS_LABEL), 'flow{Enter}');

    expect(mockPush).toHaveBeenCalledWith('/experts?q=flow');
  });

  it('reduced motion: the rotator does not advance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubPrefersReducedMotion(true);
    const [firstRotatorLine] = VERTICAL.rotator;
    if (firstRotatorLine === undefined) throw new Error('VERTICAL.rotator must have an entry');

    render(<ReducedMotionHarness taxonomy={HERO_TAXONOMY} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(screen.getByText(firstRotatorLine)).toBeInTheDocument();
    vi.useRealTimers();
  });

  // The mirror of the test above. Without this, a regression that froze the rotator — the ref's
  // FIRST-NAMED motion device — would ship green: the reduced-motion test would still pass,
  // because a permanently-static rotator satisfies it perfectly.
  it('normal motion: the rotator DOES advance (mirror of the reduced-motion guard)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubPrefersReducedMotion(false);
    const [firstRotatorLine, secondRotatorLine] = VERTICAL.rotator;
    if (firstRotatorLine === undefined || secondRotatorLine === undefined) {
      throw new Error('VERTICAL.rotator must have at least two entries');
    }

    render(<ReducedMotionHarness taxonomy={HERO_TAXONOMY} />);
    expect(screen.getByText(firstRotatorLine)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });

    expect(screen.getByText(secondRotatorLine)).toBeInTheDocument();
    expect(screen.queryByText(firstRotatorLine)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('AC 10 structural guard: submit is type=submit, all classes are mk2-*, no shared Button', () => {
    const { container } = render(<Hero taxonomy={HERO_TAXONOMY} />);

    const submitBtn = screen.getByRole('button', { name: /find an expert/i });
    expect(submitBtn).toHaveAttribute('type', 'submit');
    const classes = Array.from(submitBtn.classList);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith('mk2-')).toBe(true);
    }
    expect(container.querySelectorAll('[data-slot="button"]')).toHaveLength(0);
  });
});
