/**
 * The client's toast Join leaves a single-use answer intent here, then navigates to the call
 * route. The call page's probe join answers `409 call_answer_required`; `useCallNowAnswer` takes
 * the matching intent and commits the answer without a second click. A reload or any other Join
 * finds no intent, so a commit only ever follows a click on the toast's Join.
 */

const ANSWER_INTENT_KEY = 'balo.callNow.answerIntent';

/** An intent older than this is ignored. */
export const ANSWER_INTENT_TTL_MS = 60_000;

interface AnswerIntent {
  readonly meetingId: string;
  readonly ringId: string;
  readonly at: number;
}

function isAnswerIntent(value: unknown): value is AnswerIntent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.meetingId === 'string' &&
    typeof record.ringId === 'string' &&
    typeof record.at === 'number'
  );
}

export function markAnswerIntent(
  input: Readonly<{ meetingId: string; ringId: string }>,
  nowMs: number = Date.now()
): void {
  try {
    const intent: AnswerIntent = { ...input, at: nowMs };
    globalThis.sessionStorage.setItem(ANSWER_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Storage unavailable: the call page shows the Answer notice instead.
  }
}

/**
 * Returns the ring id of an unexpired intent for `meetingId`, or `null`. The stored intent is
 * removed on every take, whether or not it matched, so it can be used once.
 */
export function takeAnswerIntent(meetingId: string, nowMs: number = Date.now()): string | null {
  try {
    const raw = globalThis.sessionStorage.getItem(ANSWER_INTENT_KEY);
    if (raw === null) return null;
    globalThis.sessionStorage.removeItem(ANSWER_INTENT_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!isAnswerIntent(parsed)) return null;
    if (parsed.meetingId !== meetingId) return null;
    if (nowMs - parsed.at > ANSWER_INTENT_TTL_MS) return null;
    return parsed.ringId;
  } catch {
    return null;
  }
}
