import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { JoinControl } from './join-control';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * server markup must not depend on it (an `initial` or `whileTap` present in one and absent in
 * the other hydrates to a different style / `tabindex`).
 */
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: vi.fn(),
}));

function markup(): string {
  return renderToStaticMarkup(
    <JoinControl
      token={'z'.repeat(43)}
      meetingId="0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d"
      scheduledStartIso="2099-09-01T10:00:00.000Z"
      scheduledEndIso="2099-09-01T11:00:00.000Z"
      utcWindowLabel="10:00 – 11:00 UTC"
      hasEnded={false}
      hasChat={false}
      recapHref={null}
      nextStepLine="Come back to this page when it is time."
      expiresOn="8 September 2099"
    >
      <h1>Design review</h1>
    </JoinControl>
  );
}

describe('JoinControl reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(markup()).toBe(unresolved);
    expect(unresolved).toContain('Design review');
  });
});
