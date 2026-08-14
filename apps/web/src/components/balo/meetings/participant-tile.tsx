'use client';

import { useEffect, useRef } from 'react';
import { MicOff } from 'lucide-react';
import { useMediaTrack, useParticipantProperty } from '@daily-co/daily-react';
import { cn } from '@/lib/utils';
import { MeetingAvatar } from './meeting-avatar';

/**
 * BAL-435 — ONE tile component, used by spotlight, gallery and the screen-share strip.
 *
 * ⚠⚠ FOUR THINGS HERE ARE NOT STYLE PREFERENCES:
 *
 *   · `playsInline` IS MANDATORY. Without it iOS Safari takes the video fullscreen-native on
 *     play and the entire Balo UI disappears behind the vendor's own player chrome.
 *   · `muted` GOES ON THE **LOCAL** TILE ONLY. It is echo prevention for yourself; on a remote
 *     tile it is silence for everyone else.
 *   · THE HOST PILL RENDERS FROM **DAILY'S `owner` FLAG ON THAT PARTICIPANT** — not from a role,
 *     not from a lens, and not from the local `isOwner` prop. The local viewer being a host says
 *     nothing about who the tile shows.
 *   · THE NAME OVERLAY SITS ON `bg-black/55`, WHICH CLEARS 4.5:1 OVER ANY VIDEO. **Do not reduce
 *     that opacity for aesthetics.**
 *
 * ⚠ SPEAKING IS NEVER INDICATED BY COLOUR ALONE — the ring is always paired with the mic-state
 * glyph in the overlay.
 */

export interface ParticipantTileProps {
  readonly sessionId: string;
  readonly isLocal: boolean;
  readonly isSpeaking: boolean;
  /** `true` = fills its container (spotlight / screen-share primary). */
  readonly big?: boolean;
  /**
   * `true` = fill the grid CELL rather than impose a 16:10 box.
   *
   * ⚠⚠ THE GALLERY MUST SHRINK TO FIT. An aspect-ratio tile derives its height from the column
   * WIDTH, which inside a fixed-height `overflow-hidden` stage sliced ~80px off the top and
   * bottom of every face at 3, 4, 7, 8 and 9 participants. The CELL owns the shape now; the tile
   * fills it.
   */
  readonly fill?: boolean;
  /**
   * Which of the participant's tracks to render.
   *
   * ⚠ `screenVideo` IS **NEVER MIRRORED AND NEVER MUTED-AS-LOCAL** — a mirrored screen share is
   * unreadable, so the mirror and the local-mute both key off `isLocal`, which a screen tile
   * passes as `false`.
   */
  readonly trackType?: 'video' | 'screenVideo';
  readonly className?: string;
}

/**
 * Attach a `MediaStreamTrack` to a media element.
 *
 * ⚠ A REF EFFECT, NEVER STATE. The track identity changes on every device switch and every
 * renegotiation; putting it in state would re-render the whole grid each time.
 */
function useAttachedTrack(track: MediaStreamTrack | null | undefined): {
  ref: React.RefObject<HTMLVideoElement | null>;
} {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (track === null || track === undefined) {
      element.srcObject = null;
      return;
    }
    element.srcObject = new MediaStream([track]);
  }, [track]);

  return { ref };
}

/** ⚠ A LOOKUP, NOT A NESTED TERNARY (SonarCloud S3358). Three shapes, one answer each. */
function shapeClassesFor(big: boolean, fill: boolean): string {
  if (big) return 'h-full rounded-[18px]';
  if (fill) return 'h-full min-h-0 rounded-xl';
  return 'aspect-[16/10] rounded-xl';
}

export function ParticipantTile({
  sessionId,
  isLocal,
  isSpeaking,
  big = false,
  fill = false,
  trackType = 'video',
  className,
}: Readonly<ParticipantTileProps>): React.JSX.Element {
  const video = useMediaTrack(sessionId, trackType);
  const audio = useMediaTrack(sessionId, 'audio');
  // ⚠ TWO SINGLE-PATH SUBSCRIPTIONS, not one array call: the array overload's return type is a
  // mapped tuple that widens to `unknown` under our inference settings, and `unknown` here would
  // mean casting — which CLAUDE.md forbids and which would hide a real shape change.
  const userName = useParticipantProperty(sessionId, 'user_name');
  const isOwnerParticipant = useParticipantProperty(sessionId, 'owner');

  const displayName = isLocal ? 'You' : (userName ?? '') || 'Guest';
  const cameraOn = !video.isOff;
  const micMuted = audio.isOff;

  const { ref: videoRef } = useAttachedTrack(video.persistentTrack);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    const track = audio.persistentTrack;
    element.srcObject = track === undefined || track === null ? null : new MediaStream([track]);
  }, [audio.persistentTrack]);

  return (
    <div
      data-testid="participant-tile"
      data-session-id={sessionId}
      className={cn(
        'bg-muted/60 relative w-full overflow-hidden',
        shapeClassesFor(big, fill),
        isSpeaking ? 'ring-primary ring-2 transition-colors duration-200' : 'border-border border',
        className
      )}
    >
      {cameraOn ? (
        <video
          ref={videoRef}
          autoPlay
          // ⚠ MANDATORY — see the docblock. iOS Safari goes fullscreen-native without it.
          playsInline
          // ⚠ LOCAL ONLY. Muting a remote tile is silence, not echo prevention.
          muted={isLocal}
          data-testid="participant-video"
          className={cn(
            'h-full w-full object-cover',
            // ⚠ SELF-VIEW IS MIRRORED; REMOTE TILES NEVER ARE.
            isLocal ? 'scale-x-[-1]' : ''
          )}
        >
          {/*
            ⚠ AN EMPTY CAPTIONS TRACK, PRESENT ONLY TO STATE THAT THERE IS NOTHING TO CAPTION.
            This element carries a LIVE WebRTC MediaStream attached imperatively via `videoRef` —
            there is no `src`, no file, and no timed-text resource that could exist for it. Live
            captioning would be a transcription feature (BAL-387's territory), not a `<track>`.
            The tag is here because the a11y rule cannot distinguish live media from recorded, and
            an explicit empty track is the honest answer: no captions are available for this
            stream, rather than captions that were forgotten.
          */}
          <track kind="captions" />
        </video>
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">
          <MeetingAvatar name={displayName} size={big ? 84 : 46} />
        </span>
      )}

      {/* ⚠ ONE `<audio>` PER **REMOTE** PARTICIPANT, NEVER FOR SELF. */}
      {isLocal ? null : (
        <audio ref={audioRef} autoPlay data-testid="participant-audio">
          <track kind="captions" />
        </audio>
      )}

      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-lg bg-black/55 px-2.5 py-1">
        {/*
          ⚠⚠ A **FILLED** CHIP, NOT `text-destructive` ON ITS OWN. In `.dark` the repo's
          `--destructive` is `oklch(0.4 …)` — a DARK red intended as a FILL behind near-white
          text, not as a foreground. As a glyph colour over `bg-black/55` it rendered at roughly
          2.6:1, under the 3:1 floor for a meaningful icon, which made "am I muted?" — the single
          most consulted state in any call UI — the dimmest thing on the tile. `destructive` as
          the background with `destructive-foreground` on top is the pairing those two tokens are
          FOR, and it clears the floor comfortably.
        */}
        {micMuted ? (
          <span className="bg-destructive flex h-[18px] w-[18px] items-center justify-center rounded-full">
            <MicOff className="text-destructive-foreground h-[11px] w-[11px]" aria-hidden="true" />
          </span>
        ) : null}
        <span className="text-xs font-medium text-white">{displayName}</span>
        {micMuted ? <span className="sr-only">Muted</span> : null}
        {/* ⚠ FROM DAILY'S OWN `owner` FLAG ON THIS PARTICIPANT. Never from a lens or a role. */}
        {isOwnerParticipant === true ? (
          <span className="bg-primary/15 text-primary rounded px-1.5 text-xs">Host</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * ⚠⚠ ONE AVATAR THAT RESOLVES ITS OWN **NAME** FROM ITS SESSION ID.
 *
 * The overflow cluster used to be handed `tiles.overflow.map(t => t.sessionId)` in a prop called
 * `names`, so it rendered initials derived from a UUID — "3F" for a person called Sam. A hook
 * cannot be called in a loop, so each avatar is its own component and subscribes for itself.
 */
function OverflowAvatar({ sessionId }: Readonly<{ sessionId: string }>): React.JSX.Element {
  const userName = useParticipantProperty(sessionId, 'user_name');
  return <MeetingAvatar name={(userName ?? '') || 'Guest'} size={28} />;
}

/**
 * The over-cap cell.
 *
 * ⚠⚠ COLLAPSING TILES NEVER COLLAPSES AUDIO. `MAX_MEETING_PARTICIPANTS` is app-side and soft —
 * it is never passed to Daily — so this UI cannot refuse a join, and dropping somebody's audio
 * because the grid ran out of cells is never acceptable.
 *
 * ⚠ NON-INTERACTIVE, WITH NO HOVER AFFORDANCE, UNTIL BAL-436 REGISTERS THE PEOPLE SLOT.
 */
export function OverflowTile({
  sessionIds,
  hiddenCount,
}: Readonly<{ sessionIds: readonly string[]; hiddenCount: number }>): React.JSX.Element {
  return (
    <div className="bg-muted/60 border-border flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed">
      <span className="flex -space-x-2">
        {/* ⚠ KEYED BY SESSION ID, never by array index (SonarCloud S6479). */}
        {sessionIds.slice(0, 3).map((sessionId) => (
          <OverflowAvatar key={sessionId} sessionId={sessionId} />
        ))}
      </span>
      <span className="text-muted-foreground text-xs font-medium">+{hiddenCount} more</span>
    </div>
  );
}
