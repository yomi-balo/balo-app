import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseReducedMotion } = vi.hoisted(() => ({
  mockUseReducedMotion: vi.fn<() => boolean>(() => false),
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import { Parallax } from './parallax';
import {
  FX_BENCH_A,
  FX_BENCH_B,
  FX_GLOW_A,
  FX_GLOW_B,
  FX_RECEIPT,
  fxBenchRow,
  fxFloat,
  type ParallaxCompute,
} from './fx';

function rect(partial: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
    ...partial,
  } as DOMRect;
}

describe('fx presets', () => {
  it('fxBenchRow slides right and drifts up for direction 1, clamped at 900px of scroll', () => {
    expect(fxBenchRow(1)(0, rect({}), 800)).toBe('translate3d(0.0px, 0.0px, 0)');
    expect(fxBenchRow(1)(300, rect({}), 800)).toBe('translate3d(66.0px, -18.0px, 0)');
    // clamps past 900px — 1500 behaves identically to 900
    expect(fxBenchRow(1)(1500, rect({}), 800)).toBe(fxBenchRow(1)(900, rect({}), 800));
  });

  it('fxBenchRow flips sign for direction -1', () => {
    expect(fxBenchRow(-1)(300, rect({}), 800)).toBe('translate3d(-66.0px, -18.0px, 0)');
  });

  it('fxFloat computes from the rect centre relative to viewport centre, ignoring scrollY', () => {
    const parentRect = rect({ top: 100, height: 200 }); // centre = 200
    // viewport 800 -> half = 400; (200 - 400) * 0.1 = -20
    expect(fxFloat(0.1)(9999, parentRect, 800)).toBe('translate3d(0, -20.0px, 0)');
  });

  it('the five named presets pin the documented factors and directions', () => {
    // centre = top + height/2 - viewportHeight/2 = 0 + 0 - 50 = -50
    const parentRect = rect({ top: 0, height: 0 });
    expect(FX_RECEIPT(0, parentRect, 100)).toBe('translate3d(0, -4.0px, 0)'); // factor 0.08
    expect(FX_GLOW_A(0, parentRect, 100)).toBe('translate3d(0, -6.0px, 0)'); // factor 0.12
    expect(FX_GLOW_B(0, parentRect, 100)).toBe('translate3d(0, 4.0px, 0)'); // factor -0.08
    expect(FX_BENCH_A(300, parentRect, 100)).toBe('translate3d(-66.0px, -18.0px, 0)'); // direction -1
    expect(FX_BENCH_B(300, parentRect, 100)).toBe('translate3d(66.0px, -18.0px, 0)'); // direction 1
  });
});

describe('Parallax', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(globalThis, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(globalThis, 'removeEventListener');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    vi.unstubAllGlobals();
    mockUseReducedMotion.mockReturnValue(false);
  });

  it('under reduced motion: attaches no scroll/resize listener and leaves style.transform empty', () => {
    mockUseReducedMotion.mockReturnValue(true);
    const compute = vi.fn<ParallaxCompute>(() => 'translate3d(0, 999px, 0)');

    render(
      <Parallax compute={compute}>
        <p>content</p>
      </Parallax>
    );

    const el = screen.getByText('content').parentElement as HTMLElement;
    expect(el.style.transform).toBe('');
    expect(compute).not.toHaveBeenCalled();
    const scrollCalls = addEventListenerSpy.mock.calls.filter(
      ([type]: [string, ...unknown[]]) => type === 'scroll'
    );
    expect(scrollCalls).toHaveLength(0);
  });

  /**
   * BAL-493 fix round 1 (UX MINOR 3) — `Parallax` took only `compute`/`className`/`children`,
   * so the two decorative `.mk-xband-glow` divs it wraps were exposed to assistive tech while
   * the `.mk-xband-grid` three lines away was correctly hidden. `ariaHidden` is OPT-IN, never
   * defaulted: the same component wraps the pricing receipt, which must stay readable.
   */
  it('omits aria-hidden entirely when the prop is not passed (content wrappers stay readable)', () => {
    mockUseReducedMotion.mockReturnValue(true);

    render(
      <Parallax compute={vi.fn<ParallaxCompute>(() => '')}>
        <p>content</p>
      </Parallax>
    );

    const el = screen.getByText('content').parentElement as HTMLElement;
    expect(el.hasAttribute('aria-hidden')).toBe(false);
  });

  it('sets aria-hidden on the wrapper when ariaHidden is passed (decorative layers)', () => {
    mockUseReducedMotion.mockReturnValue(true);

    const { container } = render(
      <Parallax compute={vi.fn<ParallaxCompute>(() => '')} className="mk-xband-glow" ariaHidden>
        {null}
      </Parallax>
    );

    const el = container.querySelector('.mk-xband-glow');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * BAL-493 fix round 2 (review MAJOR 8) — jsdom returns an all-zero `DOMRect` for EVERY
   * element, so `toEqual(outer.getBoundingClientRect())` used to pass identically whether
   * `parallax.tsx:58` measured `el.parentElement` (correct) or `el` itself (the feedback-loop
   * bug the docblock spends five lines warning about). Stubbing `getBoundingClientRect` to
   * return DISTINGUISHABLE rects for the wrapper vs. its parent makes the two cases produce
   * different results, so measuring the wrong element now actually fails this test.
   * Mutation-verified: temporarily changing `parallax.tsx`'s `const parent = el.parentElement ??
   * el;` to `const parent = el;` failed this exact assertion (received `WRAPPER_RECT`).
   */
  it('without reduced motion: computes a transform against the PARENT element, not the wrapper itself', () => {
    mockUseReducedMotion.mockReturnValue(false);
    const compute = vi.fn<ParallaxCompute>(() => 'translate3d(0, 42px, 0)');

    const WRAPPER_RECT = rect({ top: 111, height: 222 });
    const OUTER_RECT = rect({ top: 999, height: 1 });
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        return this.getAttribute('data-testid') === 'outer' ? OUTER_RECT : WRAPPER_RECT;
      });

    render(
      <div data-testid="outer">
        <Parallax compute={compute}>
          <p>content</p>
        </Parallax>
      </div>
    );

    const el = screen.getByText('content').parentElement as HTMLElement;
    expect(el.style.transform).toBe('translate3d(0, 42px, 0)');
    expect(compute).toHaveBeenCalled();
    const firstCall = compute.mock.calls[0];
    if (!firstCall) throw new Error('compute was not called');
    const [, parentRectArg] = firstCall;
    // The rect passed is the wrapper's PARENT (`outer`), never the wrapper's own rect.
    expect(parentRectArg).toEqual(OUTER_RECT);
    expect(parentRectArg).not.toEqual(WRAPPER_RECT);

    rectSpy.mockRestore();
  });

  it('without reduced motion: attaches passive scroll + resize listeners and cleans up on unmount', () => {
    mockUseReducedMotion.mockReturnValue(false);
    const compute = vi.fn<ParallaxCompute>(() => '');

    const { unmount } = render(
      <Parallax compute={compute}>
        <p>content</p>
      </Parallax>
    );

    const scrollCall = addEventListenerSpy.mock.calls.find(
      ([type]: [string, ...unknown[]]) => type === 'scroll'
    );
    expect(scrollCall).toBeDefined();
    expect(scrollCall?.[2]).toMatchObject({ passive: true });
    expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    const el = screen.getByText('content').parentElement as HTMLElement;
    unmount();
    expect(el.style.transform).toBe('');
    expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
