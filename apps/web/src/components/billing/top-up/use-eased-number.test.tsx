import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useEasedNumber } from './use-eased-number';

function Harness({ target, duration }: Readonly<{ target: number; duration?: number }>) {
  const value = useEasedNumber(target, duration);
  return <div data-testid="value">{value}</div>;
}

function setReducedMotion(reduced: boolean): void {
  globalThis.matchMedia = vi.fn().mockReturnValue({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof globalThis.matchMedia;
}

describe('useEasedNumber', () => {
  const originalMatchMedia = globalThis.matchMedia;

  beforeEach(() => {
    setReducedMotion(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.matchMedia = originalMatchMedia;
  });

  it('returns the initial target on mount (no animation)', () => {
    render(<Harness target={100} />);
    expect(screen.getByTestId('value')).toHaveTextContent('100');
  });

  it('sets the value instantly for reduced-motion viewers', async () => {
    setReducedMotion(true);
    const { rerender } = render(<Harness target={100} />);
    rerender(<Harness target={250} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('250'));
  });

  it('eases toward the new target across animation frames', async () => {
    // Drive rAF to completion in one synchronous tick (t >= 1 → value === target).
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now() + 10_000);
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { rerender } = render(<Harness target={100} duration={500} />);
    rerender(<Harness target={300} duration={500} />);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('300'));
  });
});
