import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-437 — the ephemeral reaction broadcast.
 *
 * ── ⚠⚠ HOW "NEVER PERSISTED" IS ACTUALLY HELD: **A SOURCE SCAN OF THE ACTION** ──────────
 *
 * ⚠⚠ AN EARLIER VERSION OF THIS DOCBLOCK DESCRIBED A `@balo/db` "TRIPWIRE MOCK" THAT DOES NOT
 * EXIST ANYWHERE IN THIS FILE, and could not have worked if it did: the action does not import
 * `@balo/db` at all, so a `vi.mock('@balo/db')` factory never runs and every assertion on it
 * would pass over nothing. It would also have stayed green after somebody added a repository
 * call through a DIFFERENT module.
 *
 * What is really used is the `describe` block below: it READS THE ACTION'S OWN SOURCE off disk
 * and asserts it names no `@balo/db`, no repository and no persistence verb.
 *
 * ⚠⚠ **IT SCANS THE CODE, NOT THE WHOLE FILE** — `codeLinesOf` strips comment lines first, and
 * that is load-bearing rather than tidy. The action's docblock has to be free to NAME the things
 * it does not do (it explains why it calls `authorizeMeetingFileAccess` instead of
 * `resolveMeetingChatAccess`, and that the latter would do a `conversationsRepository` read), and
 * a raw-text scan makes the honest explanation of an invariant trip the invariant. Stripping
 * comments is also the shared repo primitive for exactly this — see `_source-scan.ts`, whose own
 * docblock records that a trailing `// …` after real code is deliberately KEPT, so the residual
 * failure mode is a false ALARM and never a false pass.
 *
 * ⚠⚠ **THE SCAN'S REAL LIMIT, STATED RATHER THAN IMPLIED.** It proves there is no DIRECT
 * repository call *in that file*. It does NOT prove nothing on the path writes: the gate the
 * action calls (`authorizeMeetingFileAccess`) reaches `@balo/db` transitively, as it must. What
 * closes the criterion end to end is that the gate is a pure read — which is the gate's own
 * invariant, tested in `authorize-meeting-file-access.test.ts`, not something this file can see.
 *
 * ⚠ THE SCAN ALSO FAILS IF THE FILE MOVES, which is the correct failure: a reader of a relocated
 * action must re-confirm this property rather than inherit it.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const NONCE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const {
  mockRequireOnboardedUser,
  mockAuthorizeMeetingFileAccess,
  mockPublishMeetingEvent,
  mockLog,
} = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockAuthorizeMeetingFileAccess: vi.fn(),
  mockPublishMeetingEvent: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
/**
 * ⚠⚠ THE GATE IS MOCKED **AT `authorizeMeetingFileAccess`**, NOT AT `resolveMeetingChatAccess`.
 *
 * The action used to call the chat resolver, which composes this gate and then performs up to
 * two further reads — a `conversationsRepository.findByContext` and the arm's lifecycle read —
 * whose results a reaction discards. Reactions are MEETING-grain: participation is the whole
 * question. Same decision, ~4 round trips instead of ~6, on the one endpoint in this family
 * with no throttle at all.
 */
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: mockAuthorizeMeetingFileAccess,
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));
vi.mock('@/lib/realtime/ably-server', () => ({
  publishMeetingEvent: (...args: unknown[]) => {
    mockPublishMeetingEvent(...args);
    return Promise.resolve();
  },
}));
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import { sendMeetingReactionAction } from './send-meeting-reaction';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockAuthorizeMeetingFileAccess.mockResolvedValue({
    ok: true,
    side: 'client',
    meeting: { id: MEETING_ID },
    subject: { contextType: 'case', contextId: 'e1' },
  });
});

describe('sendMeetingReactionAction — ⚠⚠ it persists NOTHING', () => {
  /**
   * ⚠⚠ A **SOURCE SCAN**, AND THE REASON IS WORTH READING. The obvious version of this test —
   * mock `@balo/db` and assert nothing on it was called — is VACUOUS: the action does not
   * import `@balo/db` at all, so the mock factory never runs and the assertion passes over
   * nothing. It would stay green after somebody added a repository call through a DIFFERENT
   * module too. Reading this action's own source is the only check that actually holds the
   * acceptance criterion ("never written to the meeting record or the recap") — WITHIN the
   * limit stated in the file docblock: it sees this file, not the whole path.
   *
   * ⚠ IT ALSO FAILS IF THE FILE MOVES, which is the correct failure: a reader of a relocated
   * action must re-confirm this property rather than inherit it.
   *
   * ⚠⚠ THE DIRECTORY IS RESOLVED THROUGH `resolveRouteDir`'s CWD-CANDIDATE LIST, NOT FROM
   * `import.meta.url`. CI runs web vitest from the REPO ROOT, and a disk read anchored on a
   * single assumed cwd is the shape that passes locally and ENOENTs in CI (memory
   * `reference_web_server_disk_asset_cwd`). `import.meta.url` is additionally not a `file:` URL
   * under this transform.
   */
  const actionsDir = resolveRouteDir([
    'src/app/(call)/meetings/[meetingId]/call/_actions',
    'apps/web/src/app/(call)/meetings/[meetingId]/call/_actions',
  ]);
  const raw =
    actionsDir === ''
      ? ''
      : readFileSync(path.join(actionsDir, 'send-meeting-reaction.ts'), 'utf8');
  /**
   * ⚠⚠ **THE CODE, NOT THE FILE.** Comment lines are stripped before anything is asserted, and
   * that is the whole reason this scan is survivable: the action's docblock has to be free to
   * NAME `resolveMeetingChatAccess`'s `conversationsRepository` read while explaining why this
   * action does not make it, and `@balo/db` while stating the scan's own limit. A raw-text scan
   * makes documenting an invariant break it, which pushes the next author toward writing less
   * down — the opposite of what the invariant is for.
   *
   * ⚠ THE STRIP IS THE SHARED `_source-scan` PRIMITIVE, and it deliberately KEEPS a trailing
   * `// …` that follows real code on the same line, so the residual failure mode of the choice
   * is a false ALARM rather than a false pass.
   */
  const source = codeLinesOf(raw);

  it('guards the guard: the scan resolved a real directory and read real code', () => {
    // ⚠ WITHOUT THIS, a wrong cwd makes every assertion below pass over an EMPTY string — and,
    // now that comments are stripped, an over-eager strip would do the same. Both are caught by
    // requiring the CODE view to still contain the two names the action's body genuinely uses.
    expect(actionsDir).not.toBe('');
    expect(source).toContain('publishMeetingEvent');
    expect(source).toContain('MEETING_EVENT_REACTION');
    expect(source).toContain('authorizeMeetingFileAccess');
  });

  it('⚠⚠ imports NO repository and NO database module — the whole body is a gate and a publish', () => {
    expect(source).not.toContain('@balo/db');
    expect(source).not.toContain('Repository');
  });

  /**
   * ⚠ THE STRIP IS **LOAD-BEARING**, and this says so out loud rather than leaving it implicit.
   *
   * The action's docblock names both `@balo/db` (stating this scan's transitive limit) and
   * `conversationsRepository` (explaining the read it deliberately does NOT make), so the
   * assertion above passes because comments were removed — not because the words are absent from
   * the file. Somebody who reverts the scan to raw text gets a failure here that says why.
   *
   * ⚠ IF A DOCBLOCK REWRITE DROPS BOTH WORDS this test fails while the invariant is still
   * intact. That is a FALSE ALARM, the direction this file is allowed to be wrong in — delete
   * this test then, never the two `not.toContain`s above it.
   */
  it('guards the guard: the prose above the code DOES name both, so the strip is what passes it', () => {
    expect(raw).toContain('@balo/db');
    expect(raw).toContain('Repository');
  });

  it('⚠ names no persistence verb — no insert, no upsert, no create, no add', () => {
    for (const verb of ['.insert(', '.upsert(', '.create(', '.add(']) {
      expect(source).not.toContain(verb);
    }
  });

  it('still succeeds end to end — the property above is not achieved by doing nothing', async () => {
    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👍',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: true });
    expect(mockPublishMeetingEvent).toHaveBeenCalledTimes(1);
  });
});

describe('sendMeetingReactionAction — the publish', () => {
  it('publishes `{ emoji, nonce }` on the MEETING channel and nothing else', async () => {
    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '🎉',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: true });
    expect(mockPublishMeetingEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishMeetingEvent).toHaveBeenCalledWith(MEETING_ID, 'reaction', {
      emoji: '🎉',
      nonce: NONCE,
    });
  });

  it('⚠⚠ the payload carries NO SENDER IDENTITY — privacy-minimal by construction', async () => {
    await sendMeetingReactionAction({ meetingId: MEETING_ID, emoji: '👍', nonce: NONCE });

    const [, , payload] = mockPublishMeetingEvent.mock.calls[0] ?? [];
    expect(Object.keys(payload as object).sort()).toEqual(['emoji', 'nonce']);
  });

  it('⚠ works on a meeting with NO conversation anchor — reactions are meeting-grain', async () => {
    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👏',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: true });
    expect(mockPublishMeetingEvent).toHaveBeenCalledTimes(1);
  });
});

describe('sendMeetingReactionAction — ⚠⚠ the closed emoji set is the trust boundary', () => {
  it.each(['👎', '😢', '🙂', '<script>alert(1)</script>', ''])(
    'rejects the non-member %s at Zod, before any publish',
    async (emoji) => {
      const result = await sendMeetingReactionAction({
        meetingId: MEETING_ID,
        emoji: emoji as never,
        nonce: NONCE,
      });

      expect(result).toEqual({ success: false, error: 'Invalid request.' });
      expect(mockPublishMeetingEvent).not.toHaveBeenCalled();
    }
  );

  it('rejects a non-uuid nonce', async () => {
    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👍',
      nonce: 'not-a-uuid',
    });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockPublishMeetingEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid meetingId', async () => {
    const result = await sendMeetingReactionAction({
      meetingId: 'nope',
      emoji: '👍',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });
});

describe('sendMeetingReactionAction — refusals', () => {
  it('unauthenticated ⇒ the shipped literal, and no gate call', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👍',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorizeMeetingFileAccess).not.toHaveBeenCalled();
    expect(mockPublishMeetingEvent).not.toHaveBeenCalled();
  });

  it('a denied gate refuses before the publish', async () => {
    mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👍',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: false, error: 'You are not in this call.' });
    expect(mockPublishMeetingEvent).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE GATE IS CALLED WITH THE **SESSION'S** `user.id`, NEVER ANYTHING OFF THE REQUEST. The
   * input schema is `.strict()` and has no `userId` key, so there is no path from a request body
   * to this argument — this assertion pins that the resolved session identity is what is passed.
   */
  it('passes the SESSION user id and the validated meetingId to the gate — nothing from input', async () => {
    await sendMeetingReactionAction({ meetingId: MEETING_ID, emoji: '👍', nonce: NONCE });

    expect(mockAuthorizeMeetingFileAccess).toHaveBeenCalledTimes(1);
    expect(mockAuthorizeMeetingFileAccess).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });
  });

  it('a thrown gate becomes friendly copy', async () => {
    mockAuthorizeMeetingFileAccess.mockRejectedValue(new Error('db down'));

    const result = await sendMeetingReactionAction({
      meetingId: MEETING_ID,
      emoji: '👍',
      nonce: NONCE,
    });

    expect(result).toEqual({ success: false, error: 'Could not send that reaction.' });
  });
});
