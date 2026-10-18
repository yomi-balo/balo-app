import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PreJoin } from './prejoin';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * markup must not depend on it (a `whileTap` present in one and absent in the other makes motion
 * add `tabindex` to only one of them).
 */
vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

function markup(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <PreJoin
        displayName="Dana Okafor"
        isJoining={false}
        micOn
        cameraOn
        onToggleMic={vi.fn()}
        onToggleCamera={vi.fn()}
        onOpenSettings={vi.fn()}
        onJoin={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe('PreJoin reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const reduced = markup();
    expect(reduced).toBe(unresolved);
    expect(unresolved).toContain('Join now');
  });
});
