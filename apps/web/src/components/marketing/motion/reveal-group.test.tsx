import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';

const { mockUseReducedMotion } = vi.hoisted(() => ({
  mockUseReducedMotion: vi.fn<() => boolean>(() => false),
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import { RevealGroup } from './reveal-group';

type Cb = (entries: Partial<IntersectionObserverEntry>[]) => void;

/**
 * Spies on every `IntersectionObserver` constructed so a test can assert construction never
 * happened (reduced motion) or feed a fabricated intersection entry to the captured callback.
 * Mirrors `expert-profile-client.test.tsx`'s `CapturingObserver` pattern.
 */
function installObserverSpy(): {
  callbacks: Cb[];
  observeSpy: ReturnType<typeof vi.fn>;
  disconnectSpy: ReturnType<typeof vi.fn>;
  constructorSpy: ReturnType<typeof vi.fn>;
} {
  const callbacks: Cb[] = [];
  const observeSpy = vi.fn();
  const disconnectSpy = vi.fn();
  const constructorSpy = vi.fn();

  class SpyObserver {
    constructor(cb: IntersectionObserverCallback, init?: IntersectionObserverInit) {
      constructorSpy(init);
      callbacks.push(cb as unknown as Cb);
    }
    observe(target: Element): void {
      observeSpy(target);
    }
    unobserve(): void {}
    disconnect(): void {
      disconnectSpy();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver = SpyObserver as unknown as typeof IntersectionObserver;
  return { callbacks, observeSpy, disconnectSpy, constructorSpy };
}

describe('RevealGroup', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  afterEach(() => {
    globalThis.IntersectionObserver = originalIntersectionObserver;
    mockUseReducedMotion.mockReturnValue(false);
  });

  it('renders the "mk-reveal-group" wrapper class unconditionally (server-safe)', () => {
    mockUseReducedMotion.mockReturnValue(false);
    render(
      <RevealGroup>
        <p>content</p>
      </RevealGroup>
    );
    const wrapper = screen.getByText('content').parentElement;
    expect(wrapper?.className).toContain('mk-reveal-group');
  });

  it('under reduced motion: is `.is-in` immediately and constructs NO IntersectionObserver', () => {
    const { constructorSpy } = installObserverSpy();
    mockUseReducedMotion.mockReturnValue(true);

    render(
      <RevealGroup>
        <p>content</p>
      </RevealGroup>
    );

    const wrapper = screen.getByText('content').parentElement;
    expect(wrapper?.className).toContain('mk-reveal-group');
    expect(wrapper?.className).toContain('is-in');
    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('without reduced motion: starts NOT in view, observes the element, then adds `.is-in` on intersection', () => {
    const { callbacks, observeSpy, disconnectSpy } = installObserverSpy();
    mockUseReducedMotion.mockReturnValue(false);

    render(
      <RevealGroup>
        <p>content</p>
      </RevealGroup>
    );

    const wrapper = screen.getByText('content').parentElement;
    expect(wrapper?.className).not.toContain('is-in');
    expect(observeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      for (const cb of callbacks) cb([{ isIntersecting: true }]);
    });

    expect(screen.getByText('content').parentElement?.className).toContain('is-in');
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('is `.is-in` immediately when IntersectionObserver is undefined (SSR/jsdom fallback)', () => {
    // @ts-expect-error deliberately deleting a global for the test
    delete globalThis.IntersectionObserver;
    mockUseReducedMotion.mockReturnValue(false);

    render(
      <RevealGroup>
        <p>content</p>
      </RevealGroup>
    );

    expect(screen.getByText('content').parentElement?.className).toContain('is-in');
  });

  it('supports a custom `as` tag and an additional className', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(
      <RevealGroup as="section" className="mk-ways">
        <p>content</p>
      </RevealGroup>
    );
    const wrapper = screen.getByText('content').parentElement;
    expect(wrapper?.tagName).toBe('SECTION');
    expect(wrapper?.className).toContain('mk-reveal-group');
    expect(wrapper?.className).toContain('mk-ways');
  });
});
