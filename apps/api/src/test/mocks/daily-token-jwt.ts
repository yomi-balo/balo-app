import { SignJWT, decodeJwt } from 'jose';
import type {
  MeetingTokenMinter,
  MeetingTokenRequest,
  MintedMeetingToken,
} from '../../services/daily/meeting-tokens.js';

/**
 * BAL-132 (ADDENDUM A2.1) — A `MeetingTokenMinter` THAT MINTS A **REAL JWT**, and the decoder
 * that reads one back.
 *
 * ⚠⚠ WHY THIS EXISTS, AND WHY A `vi.fn()` SPY IS NOT ENOUGH. Asserting that a stubbed minter
 * "was called with the right arguments" proves the CALL SITE and nothing about the
 * CREDENTIAL. It is exactly the shape of test that stays green while the thing a browser
 * actually receives is wrong — a mis-encoded identity, an `exp` in the wrong unit, owner
 * rights on the wrong side. The ruling was explicit: **decode the token and assert its
 * claims.**
 *
 * ⚠⚠ AND THE DECODER IS DELIBERATELY NOT THE BUILDER. `readMeetingTokenClaims` uses `jose`'s
 * `decodeJwt`, and the assertions read the identity back through
 * `parseDailyParticipantId` — a DIFFERENT function from the `dailyParticipantIdFor` that
 * wrote it. A test that reconstructed the expected token with the same helper that built it
 * would assert nothing at all: it would compare a function against itself and pass for any
 * encoding, including a broken one.
 *
 * ── ⚠ WHAT THIS DOES AND DOES NOT PROVE ────────────────────────────────────────────────
 *
 * PROVES: the claims our code puts on the wire survive a real serialise → sign → parse round
 * trip, in the exact shape Daily receives them; the identity encoding round-trips; `exp` is
 * seconds and equals scheduled end + 24h; `is_owner` tracks the capability verdict;
 * `eject_at_token_exp` is absent.
 *
 * DOES NOT PROVE: that Daily ACCEPTS the request body. Nothing offline can. That gap is
 * closed by the manually-runnable live smoke script at `scripts/daily-token-smoke.ts`,
 * which needs a real `DAILY_API_KEY` and is deliberately NOT wired into CI.
 *
 * ⚠ THE SIGNING SECRET IS A TEST CONSTANT AND MEANS NOTHING. Daily signs with the account's
 * API key; we are not verifying a signature here, we are exercising a real JWT codec so the
 * payload cannot be asserted against itself.
 */
const TEST_SIGNING_SECRET = new TextEncoder().encode(
  'bal132-test-signing-secret-not-a-real-daily-key'
);

/** The claim shape Daily puts inside a meeting token, as far as this ticket cares. */
export interface MeetingTokenClaims {
  readonly r?: unknown;
  readonly room_name?: unknown;
  readonly u?: unknown;
  readonly user_name?: unknown;
  readonly user_id?: unknown;
  readonly is_owner?: unknown;
  readonly exp?: unknown;
  readonly eject_at_token_exp?: unknown;
}

/** Every request this minter was asked for, in order — for the absence assertions. */
export interface RecordingJwtMinter extends MeetingTokenMinter {
  readonly requests: MeetingTokenRequest[];
}

/**
 * A minter that builds a genuine signed JWT carrying EXACTLY the claims Daily would derive
 * from our request body — nothing added, nothing defaulted.
 *
 * ⚠ IT COPIES ONLY WHAT THE CALLER SENT. In particular it does NOT invent
 * `eject_at_token_exp`, so a test asserting that claim is absent is asserting something about
 * OUR request rather than about this helper's generosity.
 */
export function createJwtMinter(): RecordingJwtMinter {
  const requests: MeetingTokenRequest[] = [];

  return {
    requests,
    async createMeetingToken(request: MeetingTokenRequest): Promise<MintedMeetingToken> {
      requests.push(request);
      const token = await new SignJWT({
        room_name: request.roomName,
        user_name: request.userName,
        user_id: request.participantId,
        is_owner: request.isOwner,
      })
        .setProtectedHeader({ alg: 'HS256' })
        // ⚠ `setExpirationTime` takes SECONDS when given a number, which is the same unit
        // `MeetingTokenRequest.expiresAtUnix` is documented in. If our code ever passed
        // milliseconds, the decoded `exp` would be ~1000× too large and the assertion in
        // `join-meeting.test.ts` would catch it.
        .setExpirationTime(request.expiresAtUnix)
        .sign(TEST_SIGNING_SECRET);
      return { token };
    },
  };
}

/**
 * Decode a minted token's claims. ⚠ `decodeJwt` — NOT a re-serialisation, and deliberately
 * not a verification either: the signature is meaningless here (see the module docblock), and
 * verifying it would only prove this helper agrees with itself.
 */
export function readMeetingTokenClaims(token: string): MeetingTokenClaims {
  return decodeJwt(token) as MeetingTokenClaims;
}
