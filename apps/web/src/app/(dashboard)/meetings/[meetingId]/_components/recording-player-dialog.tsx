'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { RecapLens } from '@/lib/meetings/recap-view-types';

/**
 * BAL-440 — the recording playback modal. `<video controls>` for native keyboard operability
 * and fullscreen at zero custom-chrome cost, with `hls.js` attached ONLY when the browser has
 * no native HLS support (design C-1: Chrome, Edge and Firefox play nothing off a bare
 * `.m3u8` source — Safari and iOS/Android WebViews are the only native players).
 *
 * ⚠⚠ `hls.js` IS DYNAMICALLY IMPORTED, NEVER A TOP-LEVEL IMPORT. It must not sit in the main
 * bundle — it is fetched only when someone actually opens a recording, and only on a browser
 * that needs it.
 *
 * ⚠ MOBILE FULL-SCREEN TAKEOVER IS A NAMED, DELIBERATE BREAK from both the `sm:max-w-[600px]`
 * Dialog default and the "Sheets on mobile" default — a bottom sheet would crop the video's
 * width/height, exactly the wrong trade-off for the one piece of content on this page that
 * needs maximum screen real estate.
 *
 * ⚠ THE `recap_recording_played` ANALYTICS EVENT FIRES ON THE VIDEO'S FIRST `playing` EVENT,
 * NOT ON CLICK AND NOT ON MODAL OPEN — a mint that succeeds and a viewer who never presses play
 * is not a play. `fired` resets whenever `open` transitions to `true`, so a second open (a new
 * mint) can fire again; scrubbing, pausing and resuming inside ONE open never re-fire.
 *
 * ⚠⚠ THE `<video>` NODE IS TRACKED AS STATE, NOT A PLAIN `useRef`. Radix's `Portal`
 * (`@radix-ui/react-portal`) defers mounting its content by ONE render pass — it renders `null`
 * until its own `useLayoutEffect` flips a `mounted` flag — so on the FIRST commit the `<video>`
 * genuinely does not exist in the DOM yet. An attach effect keyed only on `[url]` would run
 * once against a `null` ref and never retry, since `url` does not change on the second commit.
 * Keying the effect on `[url, videoNode]` (a ref CALLBACK that calls `setState`) makes it
 * re-run the instant Radix actually mounts the node.
 *
 * ⚠⚠ FIX ROUND 1 (M1) — THE FAILURE SURFACE NO LONGER BLAMES THE BROWSER FOR EVERY CAUSE.
 * `playbackError` is `'unsupported' | 'load_failed' | null`, not a single boolean, because the
 * two causes are almost never the same one: `'unsupported'` is reserved for a GENUINE
 * incompatibility (`!Hls.isSupported()`, checked before an `Hls` instance is even constructed —
 * at that point no fatal error has happened yet, so there is nothing else it could be). Every
 * OTHER failure — a fatal `hls.js` error (`Hls.ErrorTypes.NETWORK_ERROR` from a 403/absent
 * `MUX_SIGNING_KEY_*`, a timeout, `MEDIA_ERROR` from a corrupt/partial segment, or anything else
 * fatal), the dynamic `import('hls.js')` itself rejecting, or the NATIVE `<video>` element's own
 * `onError` (Safari/iOS, which had no error handling at all before this fix round) — is a LOAD
 * failure, not a browser incompatibility, and gets the honest "couldn't be loaded" line instead.
 * `MUX_SIGNING_KEY_*` are not provisioned on Vercel today (`.env.example`), so a misprovisioned
 * key is the most likely first-production failure, and it must not land on a message that tells
 * the viewer their BROWSER is the problem.
 *
 * ⚠ FIX ROUND 1 (m4) — `new Hls({ autoStartLoad: false })`. hls.js defaults
 * `autoStartLoad: true`, so `loadSource()` + `attachMedia()` alone would fetch the manifest AND
 * the first segments on modal OPEN — defeating `preload="none"` for every hls.js browser
 * (Chrome, Edge, Firefox: the majority). `hlsRef` holds the live instance so the video's own
 * `onPlay` (fired the moment playback is REQUESTED, before `onPlaying` fires) can call
 * `startLoad()` — the native/Safari branch needs no equivalent, since `video.src = url` with
 * `preload="none"` already defers the browser's own fetch until playback is requested.
 *
 * ⚠ PRECISELY WHAT `autoStartLoad: false` DEFERS — do not overclaim it as "no bytes until
 * play." `loadSource()` STILL fetches the master manifest on modal open; only the level
 * playlists and the media fragments wait for `startLoad()`. That residual is a few hundred
 * bytes, and it is arguably the better trade: a 403 from an absent `MUX_SIGNING_KEY_*`
 * surfaces on OPEN rather than on first play, which is exactly the misprovisioning case
 * called out above.
 *
 * ⚠ FIX ROUND 1 (m5) — SYMMETRIC TEARDOWN. The native branch now tears itself down
 * (`pause` / `removeAttribute('src')` / `load()`) exactly like the hls.js branch's
 * `instance.destroy()` — previously only the hls.js path cleaned up after itself.
 */
export function RecordingPlayerDialog({
  open,
  onOpenChange,
  url,
  posterUrl,
  segmentIndex,
  segmentCount,
  meetingId,
  lens,
  durationSeconds,
  title,
  description,
  showCaptionsNote,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  posterUrl: string | null;
  /** 1-based, matching the "Segment {n}" copy and the `aria-label`. */
  segmentIndex: number;
  segmentCount: number;
  meetingId: string;
  lens: RecapLens;
  durationSeconds: number | null;
  title: string;
  description: string;
  showCaptionsNote: boolean;
}>): React.JSX.Element {
  const [videoNode, setVideoNode] = useState<HTMLVideoElement | null>(null);
  const fired = useRef(false);
  const [playbackError, setPlaybackError] = useState<'unsupported' | 'load_failed' | null>(null);
  const hlsRef = useRef<{ startLoad: () => void } | null>(null);

  // Reset the once-per-open guard (and any stale error state) whenever a fresh open begins —
  // a new mint deserves a fresh chance to fire and a fresh chance to play.
  useEffect(() => {
    if (open) {
      fired.current = false;
      setPlaybackError(null);
    }
  }, [open]);

  // The HLS attach (design C-1). Native `<video src>` when the browser can play HLS itself
  // (Safari, iOS/Android WebViews); `hls.js`, dynamically imported, everywhere else.
  useEffect(() => {
    const video = videoNode;
    if (video === null || url === '') {
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
      video.src = url;
      // m5 — symmetric teardown: the hls.js branch below destroys its instance on cleanup;
      // the native branch must release the media element the same way.
      return () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    }

    let instance: { destroy: () => void; startLoad: () => void } | undefined;
    let cancelled = false;
    import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          // Genuinely no way to play HLS here — the ONE case that gets the browser-blaming
          // copy, and the only path that reaches it: no fatal error has happened yet.
          setPlaybackError('unsupported');
          return;
        }
        // m4 — never fetch until the user presses play: `startLoad()` is called from
        // `handlePlay`, wired to the video's native `play` event, below.
        const hls = new Hls({ autoStartLoad: false });
        instance = hls;
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // M1 — any FATAL hls.js error at this point is a manifest/segment LOAD failure
          // (`Hls.ErrorTypes.NETWORK_ERROR` — a 403/absent MUX_SIGNING_KEY_*, a timeout —
          // or `MEDIA_ERROR` — a corrupt/partial segment — are the realistic causes; anything
          // else fatal gets the same honest message), never a browser incompatibility, which
          // is ruled out separately above by `Hls.isSupported()`.
          setPlaybackError('load_failed');
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        // ⚠ REVIEW FIX — the early-play RACE. `hlsRef` is null until this dynamic import
        // resolves, so a play pressed inside that window fires the native `play` event on a
        // still-sourceless element, `handlePlay` optional-chains to a no-op, and nothing ever
        // calls `startLoad()` — the player then sits buffering forever until the viewer
        // toggles pause/play. Re-check the element's own state here: if playback was already
        // requested, start the load now. Calling `startLoad()` this early is safe — hls.js
        // records `forceStartLoad` and acts on it at `MANIFEST_PARSED`.
        if (!video.paused) {
          hls.startLoad();
        }
      })
      .catch(() => setPlaybackError('load_failed'));

    return () => {
      cancelled = true;
      instance?.destroy();
      hlsRef.current = null;
    };
  }, [url, videoNode]);

  const handlePlay = useCallback(() => {
    // m4 — the FIRST time playback is requested (native `play`, which fires before `playing`),
    // start the hls.js load. A no-op on the native/Safari branch, where `hlsRef` is never set.
    hlsRef.current?.startLoad();
  }, []);

  const handleVideoError = useCallback(() => {
    // M1 — the native/Safari `<video>` path had no error handling at all: a failed manifest
    // load there degraded to a dead, silent player. Same honest "couldn't be loaded" message
    // as the hls.js path; genuine unsupported-browser is impossible here (native HLS support
    // is what put us on this branch in the first place).
    setPlaybackError('load_failed');
  }, []);

  const handlePlaying = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    track(RECAP_EVENTS.RECORDING_PLAYED, {
      meeting_id: meetingId,
      lens,
      segment_index: segmentIndex,
      segment_count: segmentCount,
      duration_seconds: durationSeconds,
    });
  }, [meetingId, lens, segmentIndex, segmentCount, durationSeconds]);

  const dialogTitle = segmentCount === 1 ? 'Recording' : `Segment ${segmentIndex} recording`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-dvh w-screen max-w-none gap-3 rounded-none p-4 sm:h-auto sm:max-w-4xl sm:rounded-2xl sm:p-6">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            {title} · {description}
          </DialogDescription>
        </DialogHeader>

        {playbackError !== null ? (
          <p className="text-muted-foreground text-sm">
            {playbackError === 'unsupported'
              ? "This recording can't be played in this browser."
              : "This recording couldn't be loaded. Please close and try again."}
          </p>
        ) : (
          <video
            ref={setVideoNode}
            controls
            playsInline
            preload="none"
            poster={posterUrl ?? undefined}
            aria-label={dialogTitle}
            className="aspect-video w-full bg-black"
            onPlay={handlePlay}
            onPlaying={handlePlaying}
            onError={handleVideoError}
          />
        )}

        {showCaptionsNote && (
          <p className="text-muted-foreground text-xs">
            No captions yet — read the transcript above.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
