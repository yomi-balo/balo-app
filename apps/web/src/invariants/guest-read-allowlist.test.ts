import { describe, expect, it } from 'vitest';
import { GUEST_READ_ALLOWLIST } from './_read-only-actions';
import { repositoryMemberCallsOf, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-445, fix-round-3, G1 — THE GUEST-READ WRITE-SURFACE GUARD.
 *
 * `onboarding-mutation-gate.test.ts` added `resolveMeetingGuestSubject` to `AUTH_HELPERS` so the
 * three guest read actions stop misclassifying as unauthenticated. That was correct — but it is
 * ALSO the entire reason this file has to exist. Once a module merely *references*
 * `resolveMeetingGuestSubject`, it registers as authenticated everywhere, and nothing else was
 * watching it:
 *
 *   - `onboarding-mutation-gate.test.ts` — satisfied by the mention alone; never inspects what
 *     the action DOES with the resolved subject.
 *   - `join-link-never-writes.test.ts` — excludes `_actions/` from its scan entirely (that
 *     directory is where the POST-only mutations are SUPPOSED to live).
 *   - `conversation-access-read-only.test.ts` — its subject list is derived from
 *     `READ_ONLY_ALLOWLIST`, which these three are deliberately NOT on (see that file's
 *     docblock) — they never enter its scan.
 *
 * So a future `postGuestMessageAction` that resolves a guest and then calls
 * `conversationsRepository.postMessage(...)` would pass all three invariants silently, with no
 * allowlist entry and no red build. The only remaining brakes today are the `sender_user_id`
 * schema constraint and the `party: access.side` type error — and BAL-486 removes the first BY
 * DESIGN. This guard has to exist before BAL-486 lands.
 *
 * This test closes the gap the way `_read-only-actions.ts`'s other lists already do: EXACT SET
 * EQUALITY, derived from the source rather than hand-maintained (an earlier BAL-424 invariant
 * hand-listed its subjects and silently missed one — see that file's own docblock), plus a
 * DENY-BY-VERB-PREFIX scan of every repository member each allowlisted module reaches. A
 * deny-list is deliberate here, not an allow-list of read verbs: the failure mode to prevent is
 * a NEW write member nobody enumerated, and a deny-list still catches that where an allow-list
 * of today's reads would not.
 */

function resolveSrcDir(): string {
  return resolveRouteDir(['src', 'apps/web/src']);
}

const SRC_DIR = resolveSrcDir();
const ACTIONS_DIR = resolveRouteDir(['src/app/join/_actions', 'apps/web/src/app/join/_actions']);

/** The one primitive that turns a presented token into a persisted, revocable guest subject. */
const GUEST_AUTH_HELPER = 'resolveMeetingGuestSubject';

/**
 * Verbs that change data, at minimum. A member is rejected if it STARTS WITH one of these —
 * prefix match, not exact match, so `createMany`, `ensureForContext` and `softDelete` are all
 * caught alongside a bare `create` / `ensure` / `softDelete`.
 */
const WRITE_VERB_PREFIXES: readonly string[] = [
  'create',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'ensure',
  'record',
  'claim',
  'mark',
  'set',
  'revoke',
  'add',
  'remove',
];

function isWriteMember(member: string): boolean {
  return WRITE_VERB_PREFIXES.some((verb) => member.startsWith(verb));
}

const scannedActions = scanRouteSources(ACTIONS_DIR, '', []);

/** Every `app/join/_actions/*` module (source, not test) that references the guest auth helper. */
const guestActionSubjects = scannedActions
  .filter((file) => file.code.includes(GUEST_AUTH_HELPER))
  .map((file) => `app/join/_actions/${file.rel}`)
  .sort();

describe('guest read actions never reach a write member on any repository (BAL-445 G1)', () => {
  /**
   * GUARDS THE GUARD. A bad `SRC_DIR`/`ACTIONS_DIR`, a renamed directory, or a broken filter
   * would empty the subject list and every assertion below would pass for the wrong reason.
   */
  it('resolves the join _actions directory and finds a non-empty subject set', () => {
    expect(SRC_DIR).not.toBe('');
    expect(ACTIONS_DIR).not.toBe('');
    expect(scannedActions.length).toBeGreaterThanOrEqual(6); // the six shipped join actions
    expect(guestActionSubjects.length).toBeGreaterThanOrEqual(3);
  });

  it('every module referencing resolveMeetingGuestSubject is on GUEST_READ_ALLOWLIST', () => {
    const unlisted = guestActionSubjects.filter((rel) => !GUEST_READ_ALLOWLIST.includes(rel));
    expect(
      unlisted,
      `These app/join/_actions/* modules reference ${GUEST_AUTH_HELPER} but are not on ` +
        `GUEST_READ_ALLOWLIST. Add each one with a one-line justification of what it reads — ` +
        `or, if it performs any write, it does not belong on this axis at all (it needs its own ` +
        `review, not this allowlist):\n  ${unlisted.join('\n  ')}`
    ).toEqual([]);
  });

  it('GUEST_READ_ALLOWLIST has no stale entries', () => {
    const stale = [...GUEST_READ_ALLOWLIST].filter((rel) => !guestActionSubjects.includes(rel));
    expect(
      stale,
      `These GUEST_READ_ALLOWLIST entries no longer reference ${GUEST_AUTH_HELPER} (migrated ` +
        `or removed). Prune them:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });

  /**
   * Detection guard: the matcher must actually see a repository call that IS present, and the
   * extracted member set must be non-empty. If `repositoryMemberCallsOf` ever broke (a rename,
   * a regression), every assertion below would pass vacuously — this pins three concrete,
   * known-real calls so a dead matcher fails loudly instead.
   */
  it('the repository-call scan finds the known real calls (guards against a dead matcher)', () => {
    const byRel = new Map(scannedActions.map((file) => [file.rel, file]));

    const listFiles = byRel.get('list-guest-meeting-files.ts');
    expect(listFiles).toBeDefined();
    const listCalls = repositoryMemberCallsOf(listFiles?.code ?? '');
    expect(listCalls).toContainEqual({ object: 'meetingFilesRepository', member: 'listByMeeting' });

    const downloadFile = byRel.get('get-guest-meeting-file-download.ts');
    expect(downloadFile).toBeDefined();
    const downloadCalls = repositoryMemberCallsOf(downloadFile?.code ?? '');
    expect(downloadCalls).toContainEqual({
      object: 'meetingFilesRepository',
      member: 'findInMeeting',
    });

    const fetchThread = byRel.get('fetch-guest-meeting-thread.ts');
    expect(fetchThread).toBeDefined();
    const threadCalls = repositoryMemberCallsOf(fetchThread?.code ?? '');
    expect(threadCalls).toContainEqual({
      object: 'conversationsRepository',
      member: 'listMessagesPage',
    });
  });

  it.each([...GUEST_READ_ALLOWLIST])(
    '%s touches no write member on any repository it reaches',
    (rel) => {
      const basename = rel.replace('app/join/_actions/', '');
      const file = scannedActions.find((f) => f.rel === basename);
      expect(file, `${rel} did not resolve under ${ACTIONS_DIR}`).toBeDefined();

      const calls = repositoryMemberCallsOf(file?.code ?? '');
      const writes = calls.filter((call) => isWriteMember(call.member));
      expect(
        writes,
        `${rel} calls a WRITE member on a repository: ` +
          `${writes.map((w) => `${w.object}.${w.member}`).join(', ')}. Guest read actions must ` +
          `never write — see GUEST_READ_ALLOWLIST's docblock and BAL-486.`
      ).toEqual([]);
    }
  );
});
