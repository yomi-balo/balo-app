import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { dailyState, installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
import { OverflowTile, ParticipantTile } from './participant-tile';

/**
 * BAL-435 — the ONE tile component, used by spotlight, gallery and the screen-share strip.
 *
 * ⚠⚠ THREE OF THE FOUR ASSERTIONS BELOW ARE NOT STYLE PREFERENCES:
 *
 *   · `playsInline` IS MANDATORY. Without it iOS Safari takes the video fullscreen-native on
 *     play and the entire Balo UI disappears behind the vendor's own player chrome.
 *   · `muted` GOES ON THE **LOCAL** TILE ONLY. On a remote tile it is not echo prevention — it is
 *     silence for everyone else.
 *   · THE HOST PILL RENDERS FROM **DAILY'S `owner` FLAG ON THAT PARTICIPANT**, never from the
 *     local viewer's `isOwner`. The local viewer being a host says nothing about who the tile
 *     shows — and the reverse mistake would paint a Host badge on the client.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

const LOCAL = 'local-session';
const REMOTE = 'remote-session';

/** A live camera + microphone for `sessionId`, so the `<video>` / `<audio>` branches render. */
function giveLiveTracks(sessionId: string): void {
  dailyState.tracks[sessionId] = {
    video: { isOff: false, persistentTrack: null },
    audio: { isOff: false, persistentTrack: null },
  };
}

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  dailyState.participants = {
    [LOCAL]: { user_name: 'Dana', owner: false },
    [REMOTE]: { user_name: 'Sam', owner: false },
  };
});

describe('ParticipantTile — the media element contract', () => {
  it('⚠⚠ always sets playsInline — without it iOS Safari hijacks the whole UI', () => {
    giveLiveTracks(REMOTE);
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByTestId('participant-video')).toHaveAttribute('playsinline');
  });

  it('⚠⚠ mutes the LOCAL tile — that is echo prevention for yourself', () => {
    giveLiveTracks(LOCAL);
    render(<ParticipantTile sessionId={LOCAL} isLocal isSpeaking={false} />);

    expect(screen.getByTestId('participant-video')).toHaveProperty('muted', true);
  });

  it('⚠⚠ NEVER mutes a REMOTE tile — that would be silence, not echo prevention', () => {
    giveLiveTracks(REMOTE);
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByTestId('participant-video')).toHaveProperty('muted', false);
  });

  it('renders one <audio> per REMOTE participant', () => {
    giveLiveTracks(REMOTE);
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByTestId('participant-audio')).toBeInTheDocument();
  });

  it('⚠ renders NO <audio> for self — you do not need to hear yourself', () => {
    giveLiveTracks(LOCAL);
    render(<ParticipantTile sessionId={LOCAL} isLocal isSpeaking={false} />);

    expect(screen.queryByTestId('participant-audio')).toBeNull();
  });

  it('⚠ mirrors the self-view and never a remote tile', () => {
    giveLiveTracks(LOCAL);
    giveLiveTracks(REMOTE);
    // ⚠ SCOPED WITH `within`, not with the render result's own queries: those are bound to
    // `document.body`, so a second `render()` in the same test makes them ambiguous.
    const self = render(<ParticipantTile sessionId={LOCAL} isLocal isSpeaking={false} />).container;
    expect(within(self).getByTestId('participant-video').className).toContain('scale-x-[-1]');

    const remote = render(
      <ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />
    ).container;
    expect(within(remote).getByTestId('participant-video').className).not.toContain('scale-x-[-1]');
  });

  it('⚠ a screen-share track is NEVER mirrored — a mirrored screen share is unreadable', () => {
    dailyState.tracks[REMOTE] = { screenVideo: { isOff: false, persistentTrack: null } };
    render(
      <ParticipantTile
        sessionId={REMOTE}
        isLocal={false}
        isSpeaking={false}
        trackType="screenVideo"
      />
    );

    expect(screen.getByTestId('participant-video').className).not.toContain('scale-x-[-1]');
  });

  it('falls back to an initials avatar when the camera is off', () => {
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.queryByTestId('participant-video')).toBeNull();
    expect(screen.getByText('Sam')).toBeInTheDocument();
  });
});

describe('ParticipantTile — ⚠⚠ the Host pill comes from Daily, not from a lens', () => {
  it('renders the pill when THIS participant carries Daily’s owner flag', () => {
    dailyState.participants[REMOTE] = { user_name: 'Sam', owner: true };
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByText('Host')).toBeInTheDocument();
  });

  it('⚠⚠ renders NO pill for a non-owner participant — even when the LOCAL viewer is a host', () => {
    // The local viewer's `isOwner` is not an input here, and this is the mistake the assertion
    // guards: a host watching their client must not see a Host badge on the client's tile.
    dailyState.participants[LOCAL] = { user_name: 'Dana', owner: true };
    dailyState.participants[REMOTE] = { user_name: 'Sam', owner: false };
    const { container } = render(
      <ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />
    );

    expect(container.textContent ?? '').not.toContain('Host');
  });

  it('names self "You" rather than repeating the session name back', () => {
    render(<ParticipantTile sessionId={LOCAL} isLocal isSpeaking={false} />);

    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('falls back to "Guest" when a participant has no name', () => {
    dailyState.participants[REMOTE] = { user_name: '', owner: false };
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByText('Guest')).toBeInTheDocument();
  });
});

describe('ParticipantTile — the mute and speaking indicators', () => {
  it('⚠ never signals mute by an icon alone — an sr-only word carries it too', () => {
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByText('Muted')).toBeInTheDocument();
  });

  it('drops the mute indicator once the track is live', () => {
    giveLiveTracks(REMOTE);
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.queryByText('Muted')).toBeNull();
  });

  it('⚠ never signals speaking by COLOUR alone — the ring is paired with the mic glyph', () => {
    giveLiveTracks(REMOTE);
    const { container } = render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking />);

    const tile = screen.getByTestId('participant-tile');
    expect(tile.className).toContain('ring-primary');
    // The overlay is always present and always states the mic state in words or a glyph.
    expect(container.querySelector('.bg-black\\/55')).not.toBeNull();
  });

  it('exposes the Daily session id as the stable identity, never an index', () => {
    render(<ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />);

    expect(screen.getByTestId('participant-tile')).toHaveAttribute('data-session-id', REMOTE);
  });

  it('has no accessibility violations', async () => {
    giveLiveTracks(REMOTE);
    const { container } = render(
      <ParticipantTile sessionId={REMOTE} isLocal={false} isSpeaking={false} />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('OverflowTile — the over-cap cell', () => {
  it('shows at most three avatars and the remaining count', () => {
    const { container } = render(
      <OverflowTile sessionIds={['s-ada', 's-ben', 's-cleo', 's-dev', 's-eve']} hiddenCount={5} />
    );

    expect(screen.getByText('+5 more')).toBeInTheDocument();
    expect(container.querySelectorAll('span[aria-hidden="true"]').length).toBeLessThanOrEqual(3);
  });

  it('⚠ is NON-INTERACTIVE until BAL-436 registers the People slot', () => {
    render(<OverflowTile sessionIds={['s-ada']} hiddenCount={4} />);

    // A control that opens nothing is worse than no control.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<OverflowTile sessionIds={['s-ada', 's-ben']} hiddenCount={3} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
