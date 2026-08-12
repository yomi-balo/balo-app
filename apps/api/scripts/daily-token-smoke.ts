/**
 * BAL-132 (ADDENDUM A2.2) — THE LIVE DAILY SMOKE. **MANUAL. NOT WIRED INTO CI.**
 *
 * ── WHAT GAP THIS CLOSES ────────────────────────────────────────────────────────────────
 *
 * Every automated test in this ticket runs offline. The strongest of them
 * (`join-meeting.test.ts`'s claim assertions) mints a REAL JWT through a test minter and
 * DECODES it, which proves our claims survive a serialise → sign → parse round trip in the
 * exact shape Daily receives them. What it CANNOT prove is the one thing only the vendor can
 * answer: **does Daily accept this request body, and is the token it returns usable?**
 *
 * That is the whole and only purpose of this script. It is the difference between "our JWT
 * decoder agrees with our JWT builder" and "Daily accepts this."
 *
 * ── ⚠ WHY IT IS DELIBERATELY NOT IN CI ──────────────────────────────────────────────────
 *
 *   1. It needs a REAL `DAILY_API_KEY`. Putting a live vendor credential into the CI secret
 *      set to run one smoke on every PR is a standing supply-chain and blast-radius cost for
 *      a check that changes only when the vendor does.
 *   2. It CREATES A REAL ROOM at the vendor. Rooms are created with no `exp`
 *      (`services/daily/rooms.ts`), so an un-cleaned run strands one indefinitely — this
 *      script deletes its own room in a `finally`, but a CI run killed mid-flight would not.
 *   3. It would make the pipeline fail on a Daily outage, i.e. red builds for something no
 *      commit caused.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *
 *   From the repo root, with a real key in scope:
 *
 *     DAILY_API_KEY=<your-key> npx tsx apps/api/scripts/daily-token-smoke.ts
 *
 *   Or, if `apps/api/.env.local` already holds `DAILY_API_KEY`:
 *
 *     npx dotenv -e apps/api/.env.local -- npx tsx apps/api/scripts/daily-token-smoke.ts
 *
 * ── WHAT A PASS LOOKS LIKE ──────────────────────────────────────────────────────────────
 *
 *   Six `PASS` lines and `SMOKE PASSED`, exit code 0:
 *
 *     PASS  room created and verified private
 *     PASS  Daily accepted the five-key properties body
 *     PASS  token decodes as a JWT
 *     PASS  room claim matches dailyRoomNameForMeeting
 *     PASS  identity round-trips through parseDailyParticipantId
 *     PASS  exp equals scheduled end + 24h, in seconds
 *     SMOKE PASSED
 *
 *   ⚠ A FAILURE PRINTS `FAIL` PLUS THE VENDOR'S STATUS AND BODY AND EXITS 1. That output is
 *   for a developer's terminal, NOT for a log aggregator — it deliberately contains the raw
 *   vendor response, which production code never echoes anywhere.
 *
 *   ⚠⚠ AND A FAILURE **STILL DELETES THE ROOM**. `fail()` THROWS rather than calling
 *   `process.exit()`, so the `finally` below actually runs. It used to call `process.exit(1)`
 *   from inside the `try`, which terminates the process without running any `finally` — so
 *   every FAIL stranded a live room at the vendor, forever (rooms are created with no `exp`).
 *   Do not "simplify" `fail` back into an exit.
 *
 *   The most likely real failures, and what each means:
 *     · `401` from either call        → the key is wrong or is a room-scoped rather than an
 *                                       account key.
 *     · `400` on the token call       → Daily rejected a PROPERTY. This is the finding the
 *                                       script exists for: the body's five keys have drifted
 *                                       from what the vendor accepts.
 *     · "identity did not round-trip" → `dailyParticipantIdFor` and `parseDailyParticipantId`
 *                                       have diverged, or Daily truncated `user_id` (it
 *                                       documents a 36-character maximum; our encoding is 33).
 *
 * ⚠ THE PRINTED TOKEN IS TRUNCATED TO ITS FIRST 12 CHARACTERS. It is a real credential to a
 * real (private) room for 24h, and a full one pasted into a ticket or a chat is a live key.
 *
 * ── ⚠ THIS FILE IS OUTSIDE THE APP'S TYPECHECK AND LINT SCOPE, DELIBERATELY ─────────────
 *
 * `apps/api/tsconfig.json` sets `rootDir: "src"` and `include: ["src/**\/*"]`, and the lint
 * script is `eslint src/` — so `scripts/` is covered by NEITHER. Adding it to `include` would
 * break `rootDir` and therefore the tsup build, which is a real cost for a file that runs by
 * hand. The consequence is stated rather than hidden: **a change here is not caught by
 * `pnpm typecheck` or `pnpm lint`.** Verify it manually after editing:
 *
 *   npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
 *     --strict --skipLibCheck --esModuleInterop --types node \
 *     apps/api/scripts/daily-token-smoke.ts
 */
import { randomUUID } from 'node:crypto';
import {
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  parseDailyParticipantId,
} from '@balo/shared/meetings';
import { DAILY_API_BASE } from '../src/services/daily/client.js';
import { DailyApiError } from '../src/services/daily/errors.js';
import { createRoom } from '../src/services/daily/rooms.js';
import { createMeetingToken } from '../src/services/daily/meeting-tokens.js';
import { expiresAtUnixFor } from '../src/services/meetings/meeting-liveness.js';
// ⚠ THE SAME CLAIM INTERFACE THE OFFLINE SUITE DECODES THROUGH. Sharing it is what makes the
// short-form `r` / `u` claims (which ONLY a real Daily token carries — the offline minter emits
// the long forms) DECLARED AND READ in one place, instead of declared in the mock and read as
// bare string indexes here.
import type { MeetingTokenClaims } from '../src/test/mocks/daily-token-jwt.js';

function pass(what: string): void {
  console.log(`PASS  ${what}`);
}

/**
 * The marker type `fail` throws. ⚠ A DEDICATED CLASS so the top-level handler can tell "this
 * smoke reported a failure and has already printed it" from "something unexpected blew up",
 * and print a stack only for the second.
 */
class SmokeFailure extends Error {}

/**
 * ⚠⚠ IT **THROWS**; IT DOES NOT `process.exit`. That was a real defect, not a style point.
 *
 * Every call site below sits inside the `try` whose `finally` DELETES THE ROOM THIS SCRIPT
 * CREATED. `process.exit()` terminates the process immediately and runs no `finally` block, so
 * **every FAIL stranded a live Daily room** — created with no `exp` (`services/daily/rooms.ts`
 * posts none), therefore persisting at the vendor indefinitely. The docblock claimed the
 * opposite twice, and the failure path is precisely the one a developer runs repeatedly while
 * debugging, so the leak compounded exactly when it was least likely to be noticed.
 *
 * Throwing unwinds through the `finally`, the room is deleted, and `main()`'s `.catch` sets
 * `process.exitCode = 1` — which lets Node exit naturally after flushing stdio rather than
 * truncating it, so the `FAIL` lines are actually seen.
 *
 * ⚠ THE RETURN TYPE STAYS `never`, so `return fail(...)` and bare `fail(...)` both still
 * narrow control flow for TypeScript exactly as they did.
 */
function fail(what: string, detail?: unknown): never {
  console.error(`FAIL  ${what}`);
  if (detail instanceof DailyApiError) {
    console.error(`      ${detail.method} ${detail.path} → ${detail.status}`);
    console.error(`      ${detail.body}`);
  } else if (detail !== undefined) {
    console.error(`      ${detail instanceof Error ? detail.message : String(detail)}`);
  }
  throw new SmokeFailure(what);
}

/** Decode a JWT payload without verifying it — we do not hold Daily's signing secret. */
function decodePayload(token: string): MeetingTokenClaims {
  const [, payload] = token.split('.');
  if (payload === undefined) {
    return fail('token decodes as a JWT', 'the value has no payload segment');
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MeetingTokenClaims;
}

async function main(): Promise<void> {
  if (process.env.DAILY_API_KEY === undefined || process.env.DAILY_API_KEY.length === 0) {
    return fail('DAILY_API_KEY is set', 'export a real key, or use dotenv — see the docblock');
  }

  // A throwaway meeting id, so the derived room name cannot collide with a real meeting's.
  const meetingId = randomUUID();
  const userId = randomUUID();
  const roomName = dailyRoomNameForMeeting(meetingId);
  const participantId = dailyParticipantIdFor('user', userId);
  const scheduledEnd = new Date(Date.now() + 60 * 60 * 1000);
  const expiresAtUnix = expiresAtUnixFor(scheduledEnd);

  console.log(`\nSmoking Daily with a throwaway room: ${roomName}\n`);

  try {
    // ── 1. The room. Reuses the production path, so a privacy regression fails here too.
    const room = await createRoom(roomName).catch((error: unknown) =>
      fail('room created and verified private', error)
    );
    pass('room created and verified private');

    // ── 2. THE CALL THIS SCRIPT EXISTS FOR. Production `createMeetingToken`, unmodified —
    //      so the five-key body under test is literally the one shipped.
    const minted = await createMeetingToken({
      roomName,
      userName: 'BAL-132 smoke',
      participantId,
      isOwner: true,
      expiresAtUnix,
    }).catch((error: unknown) => fail('Daily accepted the five-key properties body', error));
    pass('Daily accepted the five-key properties body');

    const claims = decodePayload(minted.token);
    pass('token decodes as a JWT');

    // ── 3. The claims. Same assertions as the offline suite, against a REAL vendor token.
    if (claims.r !== roomName && claims.room_name !== roomName) {
      fail('room claim matches dailyRoomNameForMeeting', JSON.stringify(claims));
    }
    pass('room claim matches dailyRoomNameForMeeting');

    const decodedIdentity = parseDailyParticipantId(String(claims.u ?? claims.user_id ?? ''));
    if (
      decodedIdentity === null ||
      decodedIdentity.kind !== 'user' ||
      decodedIdentity.id !== userId
    ) {
      fail('identity round-trips through parseDailyParticipantId', JSON.stringify(claims));
    }
    pass('identity round-trips through parseDailyParticipantId');

    if (claims.exp !== expiresAtUnix) {
      fail('exp equals scheduled end + 24h, in seconds', `got ${String(claims.exp)}`);
    }
    pass('exp equals scheduled end + 24h, in seconds');

    // ⚠ INFORMATIONAL, not a hard failure: Daily omits a false `eject_at_token_exp` from the
    // payload entirely, so its ABSENCE is the expected outcome and its presence-as-true is
    // the thing worth shouting about.
    if (claims.eject_at_token_exp === true) {
      fail('eject_at_token_exp is absent or false', 'Daily returned it as TRUE');
    }

    console.log(`\n      token (truncated): ${minted.token.slice(0, 12)}…`);
    console.log('\nSMOKE PASSED\n');
  } finally {
    // ⚠ CLEAN UP THE ROOM. Rooms are created with NO `exp`, so a stranded one persists
    // indefinitely at the vendor. Best-effort — a failure here must not mask a real result,
    // and the room name is meeting-derived so a leftover is always re-identifiable.
    //
    // ⚠ A BARE `fetch`, NOT `dailyRequest`: that helper accepts only GET and POST (the two
    // verbs production needs), and widening its signature to DELETE for a manual script would
    // put an un-exercised destructive verb on the shared vendor seam.
    await fetch(`${DAILY_API_BASE}/rooms/${encodeURIComponent(roomName)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY ?? ''}` },
    }).catch(() => undefined);
  }
}

/**
 * ⚠ THE EXIT CODE IS SET **OUTSIDE** THE `try/finally`, which is the whole point of the
 * refactor above: by the time this runs, the `finally` has already deleted the room.
 *
 * ⚠ `process.exitCode`, NOT `process.exit()` — the assignment lets Node drain stdout/stderr
 * and exit naturally, whereas `process.exit()` can truncate the very `FAIL` lines this script
 * exists to print.
 *
 * ⚠ AND NO `void` OPERATOR — SonarCloud S3735, refused by name elsewhere in this slice. The
 * `.catch` makes the promise non-floating on its own.
 */
main().catch((error: unknown) => {
  // A `SmokeFailure` has already printed its own FAIL line; anything else is unexpected and
  // its stack is the useful part.
  if (!(error instanceof SmokeFailure)) {
    console.error('FAIL  the smoke threw before it could report');
    console.error(error);
  }
  process.exitCode = 1;
});
