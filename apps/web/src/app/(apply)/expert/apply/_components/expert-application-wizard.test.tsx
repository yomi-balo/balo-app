import { describe, it, expect, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────
// Importing the wizard module pulls in its client-component graph; stub the
// heavy/side-effecting deps so the pure helper can be imported in isolation.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/save-draft', () => ({
  saveDraftAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../_actions/submit-application', () => ({
  submitApplicationAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            return React.createElement(prop, { ...props, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

import { stepSlideVariants } from './expert-application-wizard';

// ── Tests ────────────────────────────────────────────────────────

describe('stepSlideVariants', () => {
  it('slides in from the right and out to the left on forward navigation (full motion)', () => {
    const variants = stepSlideVariants('forward', false);
    expect(variants.initial.x).toBe(40);
    expect(variants.exit.x).toBe(-40);
    expect(variants.animate.x).toBe(0);
    expect(variants.transition.duration).toBe(0.3);
  });

  it('slides in from the left and out to the right on backward navigation (full motion)', () => {
    const variants = stepSlideVariants('backward', false);
    expect(variants.initial.x).toBe(-40);
    expect(variants.exit.x).toBe(40);
  });

  it('drops horizontal travel and shortens the transition under reduced motion', () => {
    const variants = stepSlideVariants('forward', true);
    expect(variants.initial.x).toBe(0);
    expect(variants.exit.x).toBe(0);
    expect(variants.transition.duration).toBe(0.15);
  });

  it('keeps opacity fade on both forward and backward under reduced motion', () => {
    const forward = stepSlideVariants('forward', true);
    const backward = stepSlideVariants('backward', true);
    expect(forward.initial.opacity).toBe(0);
    expect(forward.animate.opacity).toBe(1);
    expect(backward.exit.x).toBe(0);
    expect(backward.transition.duration).toBe(0.15);
  });
});
