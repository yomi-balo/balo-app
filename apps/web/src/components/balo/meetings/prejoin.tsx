'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Settings, Video, VideoOff } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useDevices, useLocalSessionId, useVideoTrack } from '@daily-co/daily-react';
import { cn } from '@/lib/utils';
import { MeetingAvatar } from './meeting-avatar';
import { MeetingToolbarButton } from './meeting-toolbar-button';

/**
 * BAL-435 — PreJoin. **Optional, skippable, never blocking.**
 *
 * ⚠⚠ THERE IS NO MANUAL NAME ENTRY ANYWHERE ON THIS SCREEN, AND THAT IS DELIBERATE. The grant
 * already binds identity (the Daily token carries `user_name` and the Decision-1
 * `participantId`), and a free-text name on a PRIVATE room is an impersonation surface.
 *
 * ⚠⚠ CAMERA BLOCKED **DOES NOT DISABLE JOIN**. Audio-only is a valid call, and so is
 * listen-only. The same is true when there are no devices at all.
 *
 * ⚠ SELF-VIEW IS MIRRORED (`scale-x-[-1]`). Remote tiles never are.
 *
 * ⚠ THE SKIP PREFERENCE IS `localStorage`, AND THE CONTRAST WITH THE LOBBY IS THE POINT: the
 * lobby token is `sessionStorage` BECAUSE IT IS A CREDENTIAL that must die with the tab. This is
 * a PREFERENCE carrying nothing sensitive, so it should persist. Read and written through
 * throw-guarded helpers — storage THROWS on access in a locked-down profile, it does not merely
 * return `null`.
 */

export const SKIP_PREJOIN_STORAGE_KEY = 'balo.meeting.skip-prejoin';

export function readSkipPrejoin(): boolean {
  try {
    return globalThis.localStorage.getItem(SKIP_PREJOIN_STORAGE_KEY) === '1';
  } catch {
    // ⚠ Locked-down profile: degrade to "always show". Never break the join.
    return false;
  }
}

export function writeSkipPrejoin(skip: boolean): void {
  try {
    if (skip) {
      globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
      return;
    }
    globalThis.localStorage.removeItem(SKIP_PREJOIN_STORAGE_KEY);
  } catch {
    // Preference not persisted. The join is unaffected, which is the whole contract.
  }
}

export interface PreJoinProps {
  /**
   * ⚠ `null` ⇒ THE IDENTITY LINE IS OMITTED ENTIRELY, never replaced with a guess. A guest has no
   * Balo account and this surface has no name input; saying nothing is the honest answer.
   */
  readonly displayName: string | null;
  readonly isJoining: boolean;
  readonly micOn: boolean;
  readonly cameraOn: boolean;
  readonly onToggleMic: () => void;
  readonly onToggleCamera: () => void;
  readonly onOpenSettings: () => void;
  readonly onJoin: () => void;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

export function PreJoin({
  displayName,
  isJoining,
  micOn,
  cameraOn,
  onToggleMic,
  onToggleCamera,
  onOpenSettings,
  onJoin,
  headingRef,
}: Readonly<PreJoinProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion() === true;
  const localSessionId = useLocalSessionId();
  const videoTrack = useVideoTrack(localSessionId);
  const { camState } = useDevices();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [skipNextTime, setSkipNextTime] = useState(false);

  useEffect(() => {
    setSkipNextTime(readSkipPrejoin());
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null) return;
    const track = videoTrack.persistentTrack;
    element.srcObject = track === undefined || track === null ? null : new MediaStream([track]);
  }, [videoTrack.persistentTrack]);

  const handleSkipChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.checked;
    setSkipNextTime(next);
    writeSkipPrejoin(next);
  }, []);

  const isCameraBlocked = camState === 'blocked' || camState === 'not-found';
  const showPreview = cameraOn && !isCameraBlocked && !videoTrack.isOff;

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex w-full max-w-[460px] flex-col items-center gap-5">
        <div className="border-border bg-muted/60 relative w-full overflow-hidden rounded-2xl border">
          <div className="aspect-[16/10] w-full">
            {showPreview ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                data-testid="prejoin-preview"
                // ⚠ SELF-VIEW IS MIRRORED.
                className="h-full w-full scale-x-[-1] object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                {isCameraBlocked ? (
                  <>
                    <VideoOff
                      className="text-muted-foreground h-[26px] w-[26px]"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground text-sm">
                      Camera blocked in your browser
                    </span>
                    <a
                      href="https://support.google.com/chrome/answer/2693767"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-primary text-[13px] font-medium"
                    >
                      How to allow it
                    </a>
                  </>
                ) : (
                  <>
                    <VideoOff
                      className="text-muted-foreground h-[26px] w-[26px]"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground text-sm">Camera off</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ⚠ 44px MINIMUM ON EVERY TARGET, including these overlaid ones. */}
          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2.5">
            <MeetingToolbarButton
              icon={micOn ? Mic : MicOff}
              label={micOn ? 'Mute' : 'Unmute'}
              state={micOn ? 'default' : 'danger'}
              pressed={!micOn}
              size="mobile"
              onClick={onToggleMic}
            />
            <MeetingToolbarButton
              icon={cameraOn ? Video : VideoOff}
              label={cameraOn ? 'Stop video' : 'Start video'}
              state={cameraOn ? 'default' : 'danger'}
              pressed={!cameraOn}
              size="mobile"
              onClick={onToggleCamera}
            />
            <MeetingToolbarButton
              icon={Settings}
              label="Camera and sound"
              size="mobile"
              onClick={onOpenSettings}
            />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-foreground text-lg font-semibold outline-none"
          >
            Ready to join?
          </h1>
          {displayName === null ? null : (
            <span className="text-muted-foreground flex items-center gap-2 text-sm">
              <MeetingAvatar name={displayName} size={24} />
              Joining as {displayName}
            </span>
          )}
        </div>

        <motion.button
          type="button"
          onClick={onJoin}
          disabled={isJoining}
          whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          /* ⚠ `disabled:opacity-80`, NOT 60 — a 60% wash on `bg-primary` drops the label under
             4.5:1 at the exact moment the person is most anxious the click registered. */
          className={cn(
            'bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-80'
          )}
        >
          {isJoining ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isJoining ? 'Joining…' : 'Join now'}
        </motion.button>

        <label
          htmlFor="meeting-skip-prejoin"
          className="text-muted-foreground flex min-h-11 cursor-pointer items-center gap-2 text-[13px]"
        >
          <input
            id="meeting-skip-prejoin"
            type="checkbox"
            checked={skipNextTime}
            onChange={handleSkipChange}
            className="accent-primary h-4 w-4"
          />
          Skip this next time
        </label>
      </div>
    </div>
  );
}
