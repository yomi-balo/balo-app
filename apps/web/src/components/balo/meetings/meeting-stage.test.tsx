import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { orderTiles, type TileCandidate } from '@/lib/meetings/order-tiles';
import { dailyState, installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
import { StageContent } from './meeting-stage';

/**
 * BAL-435 — the three video layouts.
 *
 * ⚠⚠ THE GALLERY MUST **SHRINK TO FIT**, AND THAT IS THE HEADLINE ASSERTION HERE. The grid lives
 * in a fixed-height, `overflow-hidden` stage that deliberately does not scroll on desktop, so
 * `auto-rows-min` + aspect-ratio tiles made the rows total more than the well at 3, 4, 7, 8 and 9
 * participants — `content-center` then split the excess and sliced ~80px off the top AND bottom
 * of every face. `auto-rows-fr` with `h-full` cells is what makes the tiles shrink instead.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const LOCAL = 'local-session';

function candidate(sessionId: string, overrides: Partial<TileCandidate> = {}): TileCandidate {
  return {
    sessionId,
    isLocal: sessionId === LOCAL,
    isScreenSharing: false,
    joinedAtMs: 0,
    ...overrides,
  };
}

/** `n` remotes plus self, in the frame's own ordering. */
function roomOf(remoteCount: number): ReturnType<typeof orderTiles> {
  const remotes = Array.from({ length: remoteCount }, (_, index) =>
    candidate(`remote-${index}`, { joinedAtMs: index })
  );
  return orderTiles([...remotes, candidate(LOCAL)], null);
}

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  dailyState.participants = {
    [LOCAL]: { user_name: 'You', owner: false },
    'remote-0': { user_name: 'Dana Okoro', owner: true },
    'remote-1': { user_name: 'Sam Rivera', owner: false },
  };
});

function tileCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid="participant-tile"]').length;
}

describe('StageContent — the gallery', () => {
  it('renders one tile per participant', () => {
    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={roomOf(3)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(tileCount(container)).toBe(4);
  });

  it('⚠⚠ shares the stage height across rows — tiles shrink rather than clipping faces', () => {
    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={roomOf(2)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('auto-rows-fr');
    expect(grid?.className).not.toContain('auto-rows-min');
  });

  it('⚠ the mobile gallery from seven keeps aspect rows and SCROLLS instead', () => {
    // This is the one place the gallery scrolls, and there fixed-aspect rows are the point.
    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={roomOf(7)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('snap-y');
    expect(grid?.className).toContain('auto-rows-min');
    expect(grid?.className).toContain('sm:auto-rows-fr');
  });

  it('⚠ keys every cell by its Daily session id, never by an array index (S6479)', () => {
    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={roomOf(2)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    const ids = [...container.querySelectorAll('[data-session-id]')].map((node) =>
      node.getAttribute('data-session-id')
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⚠⚠ the overflow cluster shows NAMES, never session ids rendered as initials', () => {
    // It used to be handed `tiles.overflow.map(t => t.sessionId)` in a prop called `names`, so a
    // person called Sam got the initials of a UUID.
    const overflowRoom = orderTiles(
      Array.from({ length: 12 }, (_, index) =>
        candidate(`remote-${index}`, { joinedAtMs: index })
      ).concat(candidate(LOCAL)),
      null
    );
    dailyState.participants = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `remote-${index}`,
        { user_name: `Person ${index}`, owner: false },
      ])
    );

    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={overflowRoom}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(screen.getByText(`+${overflowRoom.overflow.length} more`)).toBeInTheDocument();
    // The avatars render initials from the participant's NAME, so no session id can appear.
    expect(container.textContent ?? '').not.toContain('remote-');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <StageContent
        kind="gallery"
        tiles={roomOf(3)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('StageContent — the spotlight', () => {
  it('renders the remote large and self as a picture-in-picture', () => {
    const { container } = render(
      <StageContent
        kind="spotlight"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(tileCount(container)).toBe(2);
    expect(
      screen.getByRole('button', { name: 'Swap the small and large video' })
    ).toBeInTheDocument();
  });

  it('⚠⚠ the swap control is REAL — it was a focusable button that did nothing', () => {
    const onSwapSelf = vi.fn();
    render(
      <StageContent
        kind="spotlight"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId={null}
        onSwapSelf={onSwapSelf}
      />
    );

    return userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Swap the small and large video' }))
      .then(() => {
        expect(onSwapSelf).toHaveBeenCalledTimes(1);
      });
  });

  it('⚠ swapping puts SELF on the stage and the remote in the PIP', () => {
    const { container } = render(
      <StageContent
        kind="spotlight"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId={null}
        selfIsPrimary
      />
    );

    const [primary] = container.querySelectorAll('[data-session-id]');
    expect(primary?.getAttribute('data-session-id')).toBe(LOCAL);
  });

  it('⚠ survives the one frame where the remote has already left', () => {
    const selfOnly = orderTiles([candidate(LOCAL)], null);
    const { container } = render(
      <StageContent
        kind="spotlight"
        tiles={selfOnly}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(tileCount(container)).toBe(1);
  });
});

describe('StageContent — the screen share', () => {
  it('renders the shared screen as the primary surface', () => {
    render(
      <StageContent
        kind="screenshare"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId="remote-0"
      />
    );

    expect(screen.getByText('Screen share')).toBeInTheDocument();
  });

  it('⚠ waits visibly rather than rendering an empty box when no track has arrived', () => {
    render(
      <StageContent
        kind="screenshare"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId={null}
      />
    );

    expect(screen.getByText('Waiting for the shared screen')).toBeInTheDocument();
  });

  it('⚠ the presenter strip is desktop-only — at 375px the shared screen IS the call', () => {
    const { container } = render(
      <StageContent
        kind="screenshare"
        tiles={roomOf(1)}
        activeSpeakerId={null}
        screenSessionId="remote-0"
      />
    );

    expect(container.querySelector('.w-\\[168px\\]')?.className).toContain('hidden');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <StageContent
        kind="screenshare"
        tiles={roomOf(2)}
        activeSpeakerId={null}
        screenSessionId="remote-0"
      />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
