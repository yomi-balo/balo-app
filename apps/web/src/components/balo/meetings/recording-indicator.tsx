'use client';

import { Circle } from 'lucide-react';
import { useRecording } from '@daily-co/daily-react';
import { MeetingPill, RECORDING_PILL_MESSAGE } from './meeting-notices';

/**
 * BAL-473 (D1, D5, OD-9) — the in-call "this call is being recorded" pill. The whole reason
 * this component is three lines: recording is DECIDED AND STARTED SERVER-SIDE, on the
 * meeting's `in_progress` transition (D1 — the recorded window is the billable window), never
 * from the client.
 *
 * ⚠⚠ DESTRUCTURE `isRecording` ONLY. `useRecording()` also returns `startRecording` /
 * `stopRecording` / `updateRecording` — calling any of them from here would contradict D1 by
 * letting the client start or stop a recording that server-side jobs already own.
 * `recording-indicator.test.tsx` asserts neither is ever called.
 *
 * ⚠ `tone="neutral"`, NOT `"warning"`. Recording is a stated fact about the platform, not a
 * problem to flag.
 *
 * ⚠ NO `onAction` / `actionLabel` — a pill with no action needs no `pointer-events-auto`
 * wrapper; the pill rail itself is `pointer-events-none`.
 *
 * Accessibility is FREE and must not be re-added: `MeetingPill` renders an `<output>`, which
 * carries an implicit polite live region, so a screen-reader user is told when it appears. Do
 * NOT also wire this into `MeetingAnnouncer` — that would double-announce.
 *
 * ⚠⚠ FIX ROUND 1 (F15) — THE FILLED DOT. Plan §18 item 16 makes THIS pill the "backstop"
 * notice for a repeat joiner who skips PreJoin — the whole adequacy argument for always-on
 * recording having no OTHER notice rests on it actually being noticed. Rendered through the
 * same `tone="neutral"` treatment as an ambient "Change devices" hint, it read as routine
 * chrome. The fix is SALIENCE, not ALARM: a small filled dot (neutral/muted — never the
 * warning tone's colour) is enough to catch a skimming eye without turning a stated fact into
 * a warning.
 */
export function RecordingIndicator(): React.JSX.Element | null {
  const { isRecording } = useRecording();
  if (!isRecording) {
    return null;
  }
  return (
    <MeetingPill
      message={RECORDING_PILL_MESSAGE}
      tone="neutral"
      icon={<Circle className="h-2 w-2 fill-current" aria-hidden="true" />}
    />
  );
}
