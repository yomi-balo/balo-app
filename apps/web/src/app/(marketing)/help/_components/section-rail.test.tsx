import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import { SectionRail } from './section-rail';

const steps = [
  { n: 1, title: 'Open the profile' },
  { n: 2, title: 'Pick a time' },
  { n: 3, title: 'Confirm' },
];

let observerCallback: IntersectionObserverCallback | undefined;
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  observerCallback = undefined;
  class FakeObserver {
    constructor(callback: IntersectionObserverCallback) {
      observerCallback = callback;
    }
    observe = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  for (const step of steps) {
    const el = document.createElement('section');
    el.id = `step-${step.n}`;
    el.dataset.step = String(step.n);
    el.tabIndex = -1;
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.querySelectorAll('section').forEach((el) => el.remove());
});

describe('SectionRail', () => {
  it('lists the sections and marks the first as the current location', () => {
    render(<SectionRail slug="booking" steps={steps} />);

    expect(screen.getByRole('navigation', { name: 'Sections in this guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open the profile/ })).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByRole('button', { name: /Pick a time/ })).not.toHaveAttribute('aria-current');
  });

  it('moves aria-current, scrolls, updates the hash and tracks the jump on click', async () => {
    const replaceState = vi.spyOn(globalThis.history, 'replaceState');
    render(<SectionRail slug="booking" steps={steps} />);

    await userEvent.click(screen.getByRole('button', { name: /Pick a time/ }));

    expect(screen.getByRole('button', { name: /Pick a time/ })).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(document.getElementById('step-2')?.scrollIntoView).toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, '', '#step-2');
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.SECTION_JUMPED, { slug: 'booking', section: 2 });
  });

  it('follows the section scrolled into view', () => {
    render(<SectionRail slug="booking" steps={steps} />);
    const target = document.getElementById('step-3');

    act(() => {
      observerCallback?.(
        [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByRole('button', { name: /Confirm/ })).toHaveAttribute(
      'aria-current',
      'location'
    );
  });

  it('moves focus to the section on click', async () => {
    render(<SectionRail slug="booking" steps={steps} />);

    await userEvent.click(screen.getByRole('button', { name: /Pick a time/ }));

    expect(document.getElementById('step-2')).toHaveFocus();
  });

  it('activates the last step when scrolled to the bottom of the page', () => {
    render(<SectionRail slug="booking" steps={steps} />);
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(
      globalThis.innerHeight + 500
    );
    vi.stubGlobal('scrollY', 499);

    act(() => {
      globalThis.dispatchEvent(new Event('scroll'));
    });

    expect(screen.getByRole('button', { name: /Confirm/ })).toHaveAttribute(
      'aria-current',
      'location'
    );
  });

  it('gives each label a title for truncation', () => {
    render(<SectionRail slug="booking" steps={steps} />);
    expect(screen.getByTitle('Pick a time')).toBeInTheDocument();
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<SectionRail slug="booking" steps={steps} />);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('renders without an IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<SectionRail slug="booking" steps={steps} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
