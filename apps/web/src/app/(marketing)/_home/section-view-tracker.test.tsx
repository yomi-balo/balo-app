import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@/test/utils';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import type { MarketingHomeSection } from '@/lib/analytics';
import { SectionViewTracker } from './section-view-tracker';

const mockTrack = vi.mocked(track);

/**
 * BAL-493 fix round 2 (review MAJOR 6) — `section-view-tracker.tsx`'s IO callback never
 * executed in any test (64.7% line coverage); `section_viewed` had no emitter test at all.
 * Mirrors `expert-profile-client.test.tsx:509-540`'s `CapturingObserver` pattern: capture every
 * constructed observer's callback so the test can feed it a fabricated intersection entry.
 */
type Cb = (entries: ReadonlyArray<Partial<IntersectionObserverEntry>>) => void;

function installObserverSpy(): {
  callbacks: Cb[];
  observeSpy: ReturnType<typeof vi.fn>;
  disconnectSpy: ReturnType<typeof vi.fn>;
} {
  const callbacks: Cb[] = [];
  const observeSpy = vi.fn();
  const disconnectSpy = vi.fn();

  class SpyObserver {
    constructor(cb: IntersectionObserverCallback) {
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
  return { callbacks, observeSpy, disconnectSpy };
}

function entry(id: string, isIntersecting: boolean): Partial<IntersectionObserverEntry> {
  const target = document.createElement('section');
  target.id = id;
  return { isIntersecting, target };
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  mockTrack.mockClear();
});

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.body.innerHTML = '';
});

describe('SectionViewTracker — section_viewed (AC-6)', () => {
  it('fires section_viewed exactly once when its section intersects', () => {
    const { callbacks } = installObserverSpy();
    const hero = document.createElement('section');
    hero.id = 'hero';
    document.body.appendChild(hero);

    render(<SectionViewTracker sections={['hero']} />);

    act(() => {
      for (const cb of callbacks) cb([entry('hero', true)]);
    });

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SECTION_VIEWED, {
      section: 'hero',
    });
  });

  it('does not re-fire for the same section on a second intersection (de-duplicated via a Set)', () => {
    const { callbacks } = installObserverSpy();
    const hero = document.createElement('section');
    hero.id = 'hero';
    document.body.appendChild(hero);

    render(<SectionViewTracker sections={['hero']} />);

    act(() => {
      for (const cb of callbacks) cb([entry('hero', true)]);
    });
    act(() => {
      for (const cb of callbacks) cb([entry('hero', true)]);
    });

    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the section is NOT intersecting', () => {
    const { callbacks } = installObserverSpy();
    const hero = document.createElement('section');
    hero.id = 'hero';
    document.body.appendChild(hero);

    render(<SectionViewTracker sections={['hero']} />);

    act(() => {
      for (const cb of callbacks) cb([entry('hero', false)]);
    });

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('fires once PER section, keyed by the intersected element id', () => {
    const { callbacks } = installObserverSpy();
    const sections: MarketingHomeSection[] = ['hero', 'proof', 'ways'];
    for (const id of sections) {
      const el = document.createElement('section');
      el.id = id;
      document.body.appendChild(el);
    }

    render(<SectionViewTracker sections={sections} />);

    act(() => {
      for (const cb of callbacks) cb([entry('hero', true), entry('proof', true)]);
    });

    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SECTION_VIEWED, {
      section: 'hero',
    });
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SECTION_VIEWED, {
      section: 'proof',
    });
  });

  it('observes every section element present in the DOM on mount', () => {
    const { observeSpy } = installObserverSpy();
    const hero = document.createElement('section');
    hero.id = 'hero';
    document.body.appendChild(hero);
    const proof = document.createElement('section');
    proof.id = 'proof';
    document.body.appendChild(proof);

    render(<SectionViewTracker sections={['hero', 'proof']} />);

    expect(observeSpy).toHaveBeenCalledTimes(2);
  });

  it('renders nothing (a pure tracking component)', () => {
    installObserverSpy();
    const { container } = render(<SectionViewTracker sections={['hero']} />);
    expect(container).toBeEmptyDOMElement();
  });
});
