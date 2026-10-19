import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { LobbyResumeClient } from './lobby-resume-client';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * server markup must not depend on it (an `initial` or `whileTap` present in one and absent in
 * the other hydrates to a different style / `tabindex`).
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

function markup(): string {
  return renderToStaticMarkup(
    <LobbyResumeClient
      meetingId="0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d"
      token={'z'.repeat(43)}
      destination="/join/m/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d"
    />
  );
}

describe('LobbyResumeClient reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(markup()).toBe(unresolved);
    expect(unresolved).toContain('Getting you back in');
  });
});
