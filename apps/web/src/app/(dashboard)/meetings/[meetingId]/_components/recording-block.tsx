'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Loader2, Play, Video, VideoOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatPlaybackDuration } from '@/lib/format/duration';
import { formatLocalShortDate } from '@/lib/format/local-date';
import type { RecapLens, RecapRecordingRowView } from '@/lib/meetings/recap-view-types';
import { getMeetingRecordingPlaybackAction } from '../_actions/get-meeting-recording-playback';
import { RecordingPlayerDialog } from './recording-player-dialog';

/**
 * BAL-440 — the recap's recording block: the caption, the 1-vs-2+ branch, the status matrix,
 * the play orchestration, and the single Refresh link.
 *
 * ⚠ `recordings.length === 0` ⇒ `return null`. `FilesCard` already guards this (it never
 * mounts this component at zero rows), so this is defence in depth, not the primary control —
 * the AC's absence requirement is discharged at `FilesCard`, not here.
 *
 * ⚠ THE `bg-black/50` SCRIM AND THE `bg-black/70` DURATION BADGE ARE FIXED BLACK/WHITE IN BOTH
 * THEMES — the sanctioned photographic-overlay exception (balo-ui-skill), not a token lapse:
 * the scrim sits on an arbitrary video frame, not a themed app surface.
 *
 * ⚠ COLOUR IS NEVER THE ONLY SIGNAL. Every status pairs an icon with words; `failed` differs by
 * SHAPE (icon + copy), not by hue — `bg-muted`, never `bg-destructive/10` (this is a terminal,
 * no-fault, low-stakes outcome with no retry, not a data-load failure to alarm about).
 *
 * ⚠⚠ FIX ROUND 1 (m3) — `payload` AND `dialogOpen` ARE TWO SEPARATE PIECES OF STATE, ON
 * PURPOSE. The original code drove BOTH "is there a dialog to render at all" and "is it open"
 * off ONE `open: {…} | null` state, and rendered `<RecordingPlayerDialog open .../>` — a
 * hardcoded `open={true}` whenever mounted. Closing set that state straight to `null`, which
 * UNMOUNTED `<RecordingPlayerDialog>` (and the `<Dialog>`/`<DialogContent>` inside it)
 * SYNCHRONOUSLY, in the SAME render that would have started the exit animation — so Radix's
 * `data-state="closed"` never had a render in which to exist, and `data-[state=closed]:fade-out-0
 * / zoom-out-95` never played. `dialogOpen` now carries the CLOSE request immediately (so Radix
 * animates); `payload` (the row/url/index the dialog needs) is cleared a beat later, once the
 * animation genuinely finishes, so `<RecordingPlayerDialog>` keeps real props to animate out
 * WITH instead of vanishing mid-fade. `CLOSE_TRANSITION_MS` mirrors `duration-200` on
 * `DialogContent` (`components/ui/dialog.tsx`) — the ONE other place that number lives.
 */
const CLOSE_TRANSITION_MS = 200;

export function RecordingBlock({
  meetingId,
  lens,
  recordings,
  transcriptReady,
  meetingTitle,
  meetingOccurredAtIso,
}: Readonly<{
  meetingId: string;
  lens: RecapLens;
  recordings: RecapRecordingRowView[];
  transcriptReady: boolean;
  /** The recap's header title — threads through to the playback modal's self-contained
   * `DialogDescription` (design: "{header.title} · {formatted date}"). */
  meetingTitle: string;
  meetingOccurredAtIso: string;
}>): React.JSX.Element | null {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payload, setPayload] = useState<{
    row: RecapRecordingRowView;
    index: number;
    url: string;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const play = useCallback(
    (row: RecapRecordingRowView, index: number) => {
      setBusyId(row.recording.id);
      getMeetingRecordingPlaybackAction({ meetingId, recordingId: row.recording.id })
        .then((result) => {
          if (result.success) {
            if (closeTimeoutRef.current !== null) {
              clearTimeout(closeTimeoutRef.current);
              closeTimeoutRef.current = null;
            }
            setPayload({ row, index, url: result.url });
            setDialogOpen(true);
            return;
          }
          toast.error(result.error);
        })
        .catch(() => {
          toast.error("Couldn't load this recording. Please try again.");
        })
        .finally(() => setBusyId(null));
    },
    [meetingId]
  );

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  const closeDialog = useCallback((next: boolean) => {
    setDialogOpen(next);
    if (!next) {
      // Let Radix actually play the `duration-200` exit animation before the payload (and
      // therefore `<RecordingPlayerDialog>`'s props) disappears — see the docblock above.
      closeTimeoutRef.current = setTimeout(() => setPayload(null), CLOSE_TRANSITION_MS);
    }
  }, []);

  if (recordings.length === 0) {
    return null;
  }

  const [firstRow] = recordings;
  // ⚠ REVIEW FIX — the Refresh link shows for ANY still-processing row, not just long-tail
  // ones. The recent tier ("usually ready within a few minutes of the call ending") is
  // precisely when a refresh is MOST likely to surface a newly-ready recording; gating it on
  // long-tail only withheld the affordance from the tier that benefits most. `ready` and
  // `failed` are terminal, so a refresh there would change nothing and the link stays hidden.
  const hasProcessing = recordings.some(
    (row) => row.recording.status !== 'ready' && row.recording.status !== 'failed'
  );
  const caption = recordings.length === 1 ? 'Recording' : `Recordings (${recordings.length})`;

  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">{caption}</p>

      {recordings.length === 1 && firstRow !== undefined ? (
        <SingleRecording
          row={firstRow}
          busy={busyId === firstRow.recording.id}
          onPlay={() => play(firstRow, 1)}
        />
      ) : (
        <ul>
          {recordings.map((row, i) => (
            <CompactRow
              key={row.recording.id}
              row={row}
              index={i + 1}
              busy={busyId === row.recording.id}
              onPlay={() => play(row, i + 1)}
            />
          ))}
        </ul>
      )}

      {hasProcessing && (
        <button
          type="button"
          onClick={refresh}
          className="text-primary focus-visible:ring-ring mt-2 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Refresh
        </button>
      )}

      {payload !== null && (
        <RecordingPlayerDialog
          open={dialogOpen}
          onOpenChange={closeDialog}
          url={payload.url}
          posterUrl={payload.row.posterUrl}
          segmentIndex={payload.index}
          segmentCount={recordings.length}
          meetingId={meetingId}
          lens={lens}
          durationSeconds={payload.row.recording.durationSeconds}
          title={meetingTitle}
          description={formatLocalShortDate(meetingOccurredAtIso)}
          showCaptionsNote={transcriptReady}
        />
      )}
    </div>
  );
}

/** Which visual tier a SINGLE-segment row's status resolves to. */
type SingleTier = 'ready' | 'processing_recent' | 'processing_long_tail' | 'failed';

function singleTier(row: RecapRecordingRowView): SingleTier {
  if (row.recording.status === 'ready') return 'ready';
  if (row.recording.status === 'failed') return 'failed';
  return row.isLongTailProcessing ? 'processing_long_tail' : 'processing_recent';
}

function SingleRecording({
  row,
  busy,
  onPlay,
}: Readonly<{
  row: RecapRecordingRowView;
  busy: boolean;
  onPlay: () => void;
}>): React.JSX.Element {
  const tier = singleTier(row);

  if (tier === 'ready') {
    return <SingleReady row={row} busy={busy} onPlay={onPlay} />;
  }

  if (tier === 'failed') {
    return (
      <div className="bg-muted flex items-center gap-3 rounded-xl px-4 py-3">
        <span
          aria-hidden="true"
          className="bg-muted text-muted-foreground inline-grid h-13 w-13 flex-none place-items-center rounded-xl"
        >
          <VideoOff className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            This recording couldn&apos;t be processed
          </p>
          <p className="text-muted-foreground text-xs">
            Something went wrong on our side — this one won&apos;t be available. Everything else on
            this recap is unaffected.
          </p>
        </div>
      </div>
    );
  }

  const isLongTail = tier === 'processing_long_tail';
  return (
    <div className="bg-muted/50 flex h-20 items-center gap-3 rounded-xl px-4">
      {isLongTail ? (
        <Clock className="text-muted-foreground h-5 w-5 flex-none" aria-hidden="true" />
      ) : (
        <Loader2
          className="text-muted-foreground h-5 w-5 flex-none animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">
          {isLongTail ? 'Still processing' : 'Processing your recording…'}
        </p>
        <p className="text-muted-foreground text-xs">
          {isLongTail
            ? "This is taking longer than usual. It may still appear — nothing else on this recap depends on it, so there's no need to wait."
            : 'Usually ready within a few minutes of the call ending.'}
        </p>
      </div>
    </div>
  );
}

function SingleReady({
  row,
  busy,
  onPlay,
}: Readonly<{
  row: RecapRecordingRowView;
  busy: boolean;
  onPlay: () => void;
}>): React.JSX.Element {
  const [posterFailed, setPosterFailed] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const showImage = row.posterUrl !== null && !posterFailed;
  const duration = formatPlaybackDuration(row.recording.durationSeconds);

  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={busy}
      aria-label={duration !== null ? `Play recording, ${duration}` : 'Play recording'}
      className="group bg-muted focus-visible:ring-ring relative aspect-video w-full overflow-hidden rounded-xl focus-visible:ring-2 focus-visible:outline-none"
    >
      {/* m7 (NIT) — `showImage` already contains `row.posterUrl !== null`, but the second
          check here is load-bearing for TS narrowing: a `boolean` variable doesn't narrow the
          type of a DIFFERENT expression (`row.posterUrl`) at the `src=` attribute below, so
          removing it would reintroduce a `string | null` there under `noUncheckedIndexedAccess`
          conventions. Kept deliberately — see fix-round finding on simplifying this line. */}
      {showImage && row.posterUrl !== null && (
        // eslint-disable-next-line @next/next/no-img-element -- a signed, TTL-bound Mux URL; next/image cannot proxy an already-signed external URL
        <img
          src={row.posterUrl}
          alt=""
          onLoad={() => setPosterLoaded(true)}
          onError={() => setPosterFailed(true)}
          className={cn(
            'h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none',
            posterLoaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-full backdrop-blur-sm transition-[transform,background-color] duration-150',
            'bg-black/50 group-hover:scale-105 group-hover:bg-black/60 group-active:scale-95 motion-reduce:transform-none'
          )}
        >
          {busy ? (
            <Loader2
              className="h-5 w-5 animate-spin text-white motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Play className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true" />
          )}
        </span>
      </span>
      {duration !== null && (
        <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-xs text-white tabular-nums">
          {duration}
        </span>
      )}
    </button>
  );
}

function compactIcon(row: RecapRecordingRowView): React.JSX.Element {
  if (row.recording.status === 'ready') {
    return <Video className="text-muted-foreground h-4 w-4 flex-none" aria-hidden="true" />;
  }
  if (row.recording.status === 'failed') {
    return <VideoOff className="text-muted-foreground h-4 w-4 flex-none" aria-hidden="true" />;
  }
  if (row.isLongTailProcessing) {
    return <Clock className="text-muted-foreground h-4 w-4 flex-none" aria-hidden="true" />;
  }
  return (
    <Loader2
      className="text-muted-foreground h-4 w-4 flex-none animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

function compactMeta(row: RecapRecordingRowView): string {
  if (row.recording.status === 'ready') {
    return formatPlaybackDuration(row.recording.durationSeconds) ?? '';
  }
  if (row.recording.status === 'failed') {
    return "Couldn't process";
  }
  return 'Processing…';
}

function CompactRow({
  row,
  index,
  busy,
  onPlay,
}: Readonly<{
  row: RecapRecordingRowView;
  index: number;
  busy: boolean;
  onPlay: () => void;
}>): React.JSX.Element {
  const isReady = row.recording.status === 'ready';
  const meta = compactMeta(row);

  return (
    <li className="border-border/60 flex items-center gap-2.5 border-b py-2.5 last:border-b-0">
      {compactIcon(row)}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{`Segment ${index}`}</span>
      {/* NIT — a `ready` row with a null duration renders `''`; an empty `<span>` is dead
          markup, so render nothing rather than a visually-empty element. */}
      {meta !== '' && <span className="text-muted-foreground text-xs">{meta}</span>}
      {isReady && (
        <button
          type="button"
          onClick={onPlay}
          disabled={busy}
          aria-label={`Play segment ${index}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 min-w-11 flex-none items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
        >
          {busy ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      )}
    </li>
  );
}
