import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// JSDOM lacks ResizeObserver, which Radix primitives (Slider, Popover) rely on.
// Provide a no-op stub so those components mount in component tests.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// JSDOM lacks IntersectionObserver, which the expert-profile scroll-spy
// (expert-profile-client) and section-view analytics (expert-profile-analytics)
// rely on. Provide a no-op stub so the observer-setup effects run (rather than
// hitting their `typeof IntersectionObserver === 'undefined'` early-return).
if (!('IntersectionObserver' in globalThis)) {
  class IntersectionObserverStub {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// JSDOM lacks Element.prototype.scrollIntoView, which the StickyNav smooth-jump
// (via expert-profile-client's handleJump) calls. Stub it so clicking a nav tab
// in component tests doesn't throw.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// The logging and analytics global mocks live in `setup.mocks.ts`, which both web projects load.

// Cleanup after each test
afterEach(() => {
  cleanup();
});
