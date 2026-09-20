import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * `meetingsRepository.cancel` must void pending reschedule proposals on the transaction's own
 * `tx` handle, never `db` — a hoisted-out or wrongly-executed void could commit on a separate
 * pooled connection, independently of the cancel it's meant to share fate with.
 *
 * This is a source scan, not a behavioural test: the integration harness swaps `db` for the
 * outer transaction and pins the pool at `max: 1`, so no behavioural test can distinguish which
 * executor the void call is actually given.
 *
 * Comments are stripped from the source before scanning, since this docblock's own prose
 * mentions `tx` and `db` and would otherwise trip the scan.
 */
const SOURCE_FILE = 'meetings.ts';

const source = stripComments(
  readFileSync(fileURLToPath(new URL(`../repositories/${SOURCE_FILE}`, import.meta.url)), 'utf8')
);

/**
 * The index of `openChar`'s matching `closeChar`, scanning `text` from `openIndex` (which must
 * itself hold `openChar`) with depth tracking so a nested pair doesn't close the match early.
 * Returns -1 if the text runs out before depth returns to zero. Shared by every brace/paren
 * matcher below so the depth-tracking loop exists exactly once.
 */
function findMatchingClose(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string
): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Not a plain `indexOf('{', declStart)`: `cancel`'s inline parameter object type
 * (`audit: { actorUserId: …; actorRole: … }`) would match first. Walks the parameter list via
 * paren-matching, then brace-matches the body from the first `{` after params close.
 */
function extractMethodBody(methodStart: string): string {
  const declStart = source.indexOf(methodStart);
  if (declStart === -1) {
    throw new Error(
      `${SOURCE_FILE} no longer declares \`${methodStart}\`. If \`cancel\` moved or was ` +
        `renamed, MOVE THIS INVARIANT WITH IT — do not delete it.`
    );
  }

  const paramsOpen = source.indexOf('(', declStart);
  const paramsClose = findMatchingClose(source, paramsOpen, '(', ')');
  if (paramsClose === -1) {
    throw new Error(`Could not brace-match ${methodStart}'s parameter list in ${SOURCE_FILE}.`);
  }

  const bodyStart = source.indexOf('{', paramsClose);
  const bodyEnd = findMatchingClose(source, bodyStart, '{', '}');
  if (bodyEnd === -1) {
    throw new Error(`Could not brace-match the body of ${methodStart} in ${SOURCE_FILE}.`);
  }
  return source.slice(bodyStart, bodyEnd + 1);
}

/**
 * The `db.transaction(async (tx) => { … })` callback body — distinct from the method body as a
 * whole, since a call sitting textually AFTER this slice (but still inside the method) would
 * mean the void was hoisted OUT of the transaction to run post-commit on the bare `db` client.
 */
function transactionCallbackBody(haystack: string): string {
  const marker = 'db.transaction(async (tx) => {';
  const markerStart = haystack.indexOf(marker);
  if (markerStart === -1) {
    throw new Error(
      `cancel() no longer opens exactly \`${marker}\`. If the shape changed, update this ` +
        `invariant to match it — do not delete it.`
    );
  }
  const bodyStart = markerStart + marker.length - 1; // the callback's own opening `{`
  const bodyEnd = findMatchingClose(haystack, bodyStart, '{', '}');
  if (bodyEnd === -1) {
    throw new Error('Could not brace-match the db.transaction callback body in cancel().');
  }
  return haystack.slice(bodyStart, bodyEnd + 1);
}

/**
 * The comma-split argument list of the first call to `callPrefix` (given WITHOUT its trailing
 * `(`) inside `haystack`. Depth-aware only over parens — safe because none of the real
 * call-site arguments (`id`, `audit.actorUserId`, `result.meeting.updatedAt`, `tx`) contain a
 * nested `(` or `,`.
 */
function extractCallArgs(haystack: string, callPrefix: string): string[] {
  const callStart = haystack.indexOf(`${callPrefix}(`);
  if (callStart === -1) {
    throw new Error(`Could not find a call to ${callPrefix}( in the extracted text.`);
  }
  const openParen = callStart + callPrefix.length; // the index of the opening `(` itself
  const closeParen = findMatchingClose(haystack, openParen, '(', ')');
  if (closeParen === -1) {
    throw new Error(`Could not brace-match the call to ${callPrefix}(.`);
  }
  return haystack
    .slice(openParen + 1, closeParen)
    .split(',')
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}

const CANCEL_METHOD = 'async cancel(';
const VOID_CALL = 'rescheduleProposalsRepository.voidForCancelledMeeting';

const cancelBody = extractMethodBody(CANCEL_METHOD);

describe('invariant: BAL-421 (D1) cancel() voids the proposal ON tx, inside its own transaction', () => {
  it('guards the guard — the extracted body is non-empty and is really cancel()', () => {
    expect(cancelBody.length).toBeGreaterThan(200);
    // Three steps the docblock promises, in order — if any vanish, the slice isn't cancel()
    // and every assertion below is vacuous.
    expect(cancelBody).toContain('cancelMeetingTx(tx,');
    expect(cancelBody).toContain('MeetingNotCancellableError');
    expect(cancelBody).toContain(VOID_CALL);
  });

  it('opens EXACTLY ONE db.transaction — the void must commit or roll back WITH the cancel', () => {
    const occurrences = cancelBody.split('db.transaction(').length - 1;
    expect(
      occurrences,
      `cancel() contains ${occurrences} \`db.transaction(\` calls. It must open exactly one.`
    ).toBe(1);
  });

  it('calls voidForCancelledMeeting EXACTLY ONCE', () => {
    const occurrences = cancelBody.split(`${VOID_CALL}(`).length - 1;
    expect(occurrences).toBe(1);
  });

  // The literal-token read the module docblock's source-scan reasoning depends on.
  it('passes `tx` — NEVER `db` — as voidForCancelledMeeting’s executor argument', () => {
    const args = extractCallArgs(cancelBody, VOID_CALL);
    expect(args.length).toBeGreaterThan(0);
    expect(args).toHaveLength(4);
    const [, , , execArg] = args;
    expect(
      execArg,
      `voidForCancelledMeeting's 4th argument is "${execArg}", not "tx". Passing "db" here ` +
        `(or any executor other than the transaction's own \`tx\`) lets the void commit on a ` +
        `SEPARATE pooled connection, independently of the cancel it is meant to share fate with.`
    ).toBe('tx');
  });

  /**
   * The positional half of the guarantee: the call must sit TEXTUALLY inside the transaction
   * callback, not after it returns. This is the mechanical guard even though a hoisted call
   * using `tx` wouldn't compile (`tx` is out of scope) — it doesn't rely on that fact.
   */
  it('the voidForCancelledMeeting call site sits INSIDE the transaction callback body', () => {
    const callbackBody = transactionCallbackBody(cancelBody);
    expect(callbackBody.length).toBeGreaterThan(100);
    expect(callbackBody).toContain(`${VOID_CALL}(`);
  });

  it('the shared core cancelMeetingTx is called with its own tx, id, audit — untouched by D1', () => {
    // `cancelMeetingTx` also drives the close cascade, which cannot orphan a proposal —
    // reschedule proposals are case-grain only, and the cascade only cancels
    // `project_discovery` / `request_interaction` meetings. Pins the shared-core call at three
    // arguments, with no proposal-voiding parameter fused in.
    const cancelMeetingTxArgs = extractCallArgs(cancelBody, 'cancelMeetingTx');
    expect(cancelMeetingTxArgs).toHaveLength(3);
    expect(cancelMeetingTxArgs).toEqual(['tx', 'id', 'audit']);
  });
});
