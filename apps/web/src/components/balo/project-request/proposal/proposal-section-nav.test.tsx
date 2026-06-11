import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ProposalSectionNav, REVIEW_SECTIONS } from './proposal-section-nav';

describe('ProposalSectionNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports the canonical review sections without a Not-included chip', () => {
    const keys = REVIEW_SECTIONS.map((s) => s.key);
    expect(keys).toEqual(['overview', 'milestones', 'payment', 'terms', 'attachments']);
    expect(keys).not.toContain('exclusions');
  });

  it('renders a chip per section', () => {
    render(<ProposalSectionNav proposalId="p1" sections={REVIEW_SECTIONS} />);
    for (const section of REVIEW_SECTIONS) {
      expect(screen.getByRole('button', { name: section.label })).toBeInTheDocument();
    }
  });

  it('scrolls the matching anchor into view when a chip is clicked', async () => {
    const user = userEvent.setup();
    const scrollSpy = vi.fn();
    // Create the anchor element the chip jumps to.
    const anchor = document.createElement('section');
    anchor.id = 'sec-p1-payment';
    anchor.scrollIntoView = scrollSpy;
    document.body.appendChild(anchor);

    render(<ProposalSectionNav proposalId="p1" sections={REVIEW_SECTIONS} />);
    await user.click(screen.getByRole('button', { name: 'Payment terms' }));

    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    anchor.remove();
  });

  it('marks the clicked chip active (aria-current)', async () => {
    const user = userEvent.setup();
    render(<ProposalSectionNav proposalId="p1" sections={REVIEW_SECTIONS} />);
    const terms = screen.getByRole('button', { name: 'Terms' });
    await user.click(terms);
    expect(terms).toHaveAttribute('aria-current', 'true');
  });

  it('does not throw and observes nothing when no section anchors exist', () => {
    // No `sec-p1-*` anchors in the DOM → `elements.length === 0` early return.
    expect(() =>
      render(<ProposalSectionNav proposalId="missing" sections={REVIEW_SECTIONS} />)
    ).not.toThrow();
  });
});

// ── Scroll-spy IntersectionObserver callback (A6.4 / BAL-289) ──
describe('ProposalSectionNav — scroll-spy IntersectionObserver', () => {
  type Cb = (entries: ReadonlyArray<Partial<IntersectionObserverEntry>>) => void;
  let ioCb: Cb | undefined;
  const observed: Element[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    ioCb = undefined;
    observed.length = 0;
    // Capture the constructor callback so the test can feed it entries, exercising
    // the `entries.filter().sort()` + `const [top] = visible` + `setActiveKey` body.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          ioCb = cb as unknown as Cb;
        }
        observe(el: Element): void {
          observed.push(el);
        }
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Manually-appended anchors aren't removed by RTL cleanup — strip them so a
    // stale `sec-p1-*` (without this test's scrollIntoView mock) can't be matched
    // by a later test's getElementById.
    for (const anchor of document.querySelectorAll('[id^="sec-p1-"]')) {
      anchor.remove();
    }
  });

  /** Mount the nav alongside the section anchors it scroll-spies onto. */
  function mountWithAnchors(): void {
    for (const section of REVIEW_SECTIONS) {
      const anchor = document.createElement('section');
      anchor.id = `sec-p1-${section.key}`;
      document.body.appendChild(anchor);
    }
    render(<ProposalSectionNav proposalId="p1" sections={REVIEW_SECTIONS} />);
  }

  /** A partial IntersectionObserverEntry whose target carries the given anchor id. */
  function entry(
    id: string,
    isIntersecting: boolean,
    top: number
  ): Partial<IntersectionObserverEntry> {
    const target = document.createElement('section');
    target.id = id;
    return {
      isIntersecting,
      target,
      boundingClientRect: { top } as DOMRectReadOnly,
    };
  }

  it('marks the topmost intersecting section active from the scroll-spy callback', () => {
    mountWithAnchors();
    expect(observed.length).toBe(REVIEW_SECTIONS.length);
    expect(ioCb).toBeDefined();

    // Milestones intersects at top:10 (above), Payment terms below at top:200 and
    // non-intersecting → the filter().sort() keeps only Milestones as `top`.
    act(() => {
      ioCb?.([entry('sec-p1-milestones', true, 10), entry('sec-p1-payment', false, 200)]);
    });

    expect(screen.getByRole('button', { name: 'Milestones' })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('leaves the active chip unchanged when no entry is intersecting (top === undefined)', () => {
    mountWithAnchors();
    // Overview is the default active chip (firstKey).
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'true'
    );

    act(() => {
      ioCb?.([]);
    });

    // Active unchanged — the `top === undefined` early return fired.
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Milestones' })).not.toHaveAttribute('aria-current');
  });

  it('suppresses the scroll-spy update while the click-lock is held after a chip click', async () => {
    const user = userEvent.setup();
    const anchor = document.createElement('section');
    anchor.id = 'sec-p1-terms';
    anchor.scrollIntoView = vi.fn();
    document.body.appendChild(anchor);
    mountWithAnchors();

    // Click Terms → sets active Terms AND arms clickLockRef.
    await user.click(screen.getByRole('button', { name: 'Terms' }));
    expect(screen.getByRole('button', { name: 'Terms' })).toHaveAttribute('aria-current', 'true');

    // An intersecting Milestones entry arriving while locked must be ignored.
    act(() => {
      ioCb?.([entry('sec-p1-milestones', true, 10)]);
    });
    expect(screen.getByRole('button', { name: 'Terms' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Milestones' })).not.toHaveAttribute('aria-current');

    anchor.remove();
  });

  it('jumps instantly (behavior: auto) when prefers-reduced-motion is set', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    }));
    const scrollSpy = vi.fn();
    const anchor = document.createElement('section');
    anchor.id = 'sec-p1-payment';
    anchor.scrollIntoView = scrollSpy;
    document.body.appendChild(anchor);

    render(<ProposalSectionNav proposalId="p1" sections={REVIEW_SECTIONS} />);
    await user.click(screen.getByRole('button', { name: 'Payment terms' }));

    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    anchor.remove();
  });
});
