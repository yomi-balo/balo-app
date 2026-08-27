/**
 * BAL-440 — the recap recording's duration badge/meta formatter. Pure, client-safe (no
 * `server-only`, no import at all): the duration badge and the compact-list meta both render
 * client-side inside `RecordingBlock`.
 *
 * `mm:ss` under an hour (`"45:12"`), `h:mm:ss` at or above an hour (`"1:02:15"`) — consultations
 * can run long enough that the hour digit matters (design open question 4).
 */
export function formatPlaybackDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const paddedSecs = String(secs).padStart(2, '0');

  if (hours > 0) {
    const paddedMinutes = String(minutes).padStart(2, '0');
    return `${hours}:${paddedMinutes}:${paddedSecs}`;
  }
  return `${minutes}:${paddedSecs}`;
}
