import type {
  RecapLadderState,
  RecordingLadderState,
  TranscriptionLadderState,
} from '@balo/shared/capture-health';

/**
 * BAL-550 — the presentational tone/label vocabulary for the three ladders (design reference
 * `admin-home.jsx:1061-1092`, `TONE` + `LADDER`). WEB-ONLY: `@balo/shared/capture-health`
 * deliberately carries no colour/label field (pure vocabulary, no Lucide/Tailwind dependency),
 * mirroring `AlertRow`'s own `KIND_ICONS` precedent.
 *
 * ⚠⚠ THE THREE STATE UNIONS ARE IMPORTED, NEVER RE-DECLARED. Each `Record<…LadderState, …>`
 * below is the exhaustiveness gate: a sixth state added to a canonical union in
 * `@balo/shared/capture-health` makes the matching table below a COMPILE ERROR (TS2741, the
 * missing property) instead of rendering a silent `—`. That is the whole reason this table is
 * keyed on the shared type — a local copy of the union would simply diverge, which is exactly
 * what the fifth recording state (`capturing`) was added to catch.
 *
 * A FIFTH recording state, `capturing` (§13 of the plan) — `recordingStatusEnum` has five
 * labels; the design's `LADDER.rec` names only four. Added as `{ label: 'Capturing', tone:
 * 'primary', pulse: true }`, matching `healthCategory`'s treatment (not an issue for the tile).
 */

export type CaptureHealthTone = 'success' | 'error' | 'warning' | 'primary' | 'neutral';

export interface CaptureHealthLadderMeta {
  readonly label: string;
  readonly tone: CaptureHealthTone;
  readonly pulse?: boolean;
}

/** Tailwind token triples — colour role ONLY, never a hex value. */
export const TONE: Readonly<
  Record<CaptureHealthTone, { readonly text: string; readonly bg: string; readonly border: string }>
> = {
  success: { text: 'text-success', bg: 'bg-success/10', border: 'border-success/40' },
  error: { text: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/40' },
  warning: { text: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/40' },
  primary: { text: 'text-primary', bg: 'bg-primary/10', border: 'border-primary/40' },
  neutral: { text: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
};

const REC_META: Readonly<Record<RecordingLadderState, CaptureHealthLadderMeta>> = {
  ready: { label: 'Playable', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  ingesting: { label: 'Ingesting', tone: 'primary', pulse: true },
  source_ready: { label: 'Source ready', tone: 'warning' },
  capturing: { label: 'Capturing', tone: 'primary', pulse: true },
};

const TX_META: Readonly<Record<TranscriptionLadderState, CaptureHealthLadderMeta>> = {
  finished: { label: 'Transcribed', tone: 'success' },
  submitted: { label: 'In flight', tone: 'primary', pulse: true },
  withheld: { label: 'Source held', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
  pending: { label: 'After recording', tone: 'neutral' },
  na: { label: 'Not transcribed', tone: 'neutral' },
  none: { label: '—', tone: 'neutral' },
};

const RECAP_META: Readonly<Record<RecapLadderState, CaptureHealthLadderMeta>> = {
  ready: { label: 'Ready', tone: 'success' },
  processing: { label: 'Processing', tone: 'primary', pulse: true },
  failed: { label: 'Failed', tone: 'error' },
  partial: { label: 'Ready · action items skipped', tone: 'warning' },
  none: { label: '—', tone: 'neutral' },
  na: { label: 'Not applicable', tone: 'neutral' },
};

export const LADDER_META = { rec: REC_META, tx: TX_META, recap: RECAP_META } as const;
