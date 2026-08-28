import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUEST_READ_ALLOWLIST } from './_read-only-actions';
import {
  codeLinesOf,
  namedImportsFrom,
  repositoryMemberCallsOf,
  resolveRouteDir,
  scanRouteSources,
} from './_source-scan';

/**
 * BAL-445, fix-round-4 — THE GUEST-READ WRITE-SURFACE GUARD, REBUILT.
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
 * ── ⚠⚠ ROUND-3 BUILT THE WRONG DETECTOR, AND ROUND-4 EXISTS TO FIX THE ORCHESTRATOR'S ERROR ──
 *
 * Fix-round-3's brief said to *"prefer a deny-by-verb-prefix rule over an allow-list of read
 * verbs."* That instruction was WRONG, and it inverted a pattern this repo had already reasoned
 * through and written down. `join-link-never-writes.test.ts`'s own `ALLOWED_GUEST_REPOSITORY_MEMBERS`
 * says it plainly (lines 85-88 there, quoted verbatim):
 *
 * > An ALLOW-list rather than a deny-list of today's four mutators, so a future write member
 * > added under ANY name (`transferGuest`, `reissueToken`, `admit`, …) fails here instead of
 * > shipping.
 *
 * A deny-list cannot be the gate: a new verb simply is not on it. Concretely, the round-3
 * `WRITE_VERB_PREFIXES` deny-list MISSED `conversationsRepository.postMessage` — the exact
 * member THIS FILE'S OWN DOCBLOCK NAMES, two paragraphs up, as the threat — because `post` was
 * never on the list. It also missed `meetingGuestsRepository.decideAdmission`,
 * `meetingGuestsRepository.extendExpiryForMeeting`, `conversationsRepository.attachContext` and
 * `creditSessionsRepository.open` (the money write — "never money" was unenforced). And the
 * round-3 mutation proof used `recordMutationTestProbe` — `record` IS on the deny-list, so the
 * proof exercised a verb that was already covered, not the one that mattered. Same failure mode
 * caught three times earlier in this PR: a guard that looks green because it was tested against
 * something it already handled.
 *
 * This file now mirrors `join-link-never-writes.test.ts`'s shape directly: an EXACT
 * `(object, member)` ALLOW-list is the gate (`ALLOWED_REPOSITORY_CALLS` below). The verb-prefix
 * list survives only as a SECONDARY tripwire that improves a failure message — never the pass/
 * fail decision — and that subordination is enforced in code (see
 * `it('the verb-prefix tripwire is demonstrably not the gate…')` below), not left to a comment
 * someone could "simplify" away later.
 *
 * Two more gaps closed this round, per human review of PR #241:
 *
 *   - `ALLOWED_DB_IMPORTS` pins each guest-path module's entire named-import set from
 *     `@balo/db`, not just its `xxxRepository.member` calls. `repositoryMemberCallsOf` cannot
 *     see a bare export like `resolveMeetingContextOwner` — it has no `Repository.` in its name
 *     — so an exact-pair scan over repository calls alone has a blind spot exactly the size of
 *     "every bare `@balo/db` export". The import pin closes it.
 *   - `ALLOWED_LIB_REPOSITORY_CALLS` extends the same exact-pair scan to the THREE `lib/meetings`
 *     modules the guest actions reach transitively (`resolve-meeting-guest.ts`,
 *     `authorize-meeting-file-access.ts`, `meeting-chat-anchor.ts`), not just the three
 *     `app/join/_actions/*` files themselves. The action-level scan is per-file: it never sees
 *     that `fetch-guest-meeting-thread.ts` reaches `conversationsRepository.findByContext` only
 *     via `meeting-chat-anchor.ts`. If that ever became `ensureForContext` — BAL-424's exact
 *     defect class, already seen in this codebase — the action-level scan alone would stay
 *     green. `join-link-never-writes.test.ts` already does exactly this move for
 *     `resolve-meeting-guest.ts`'s `meetingGuestsRepository` calls; this is the same move,
 *     applied to the write axis, one more time, in the same established shape.
 */

function resolveSrcDir(): string {
  return resolveRouteDir(['src', 'apps/web/src']);
}

const SRC_DIR = resolveSrcDir();
const ACTIONS_DIR = resolveRouteDir(['src/app/join/_actions', 'apps/web/src/app/join/_actions']);

/** The one primitive that turns a presented token into a persisted, revocable guest subject. */
const GUEST_AUTH_HELPER = 'resolveMeetingGuestSubject';

/**
 * NOT THE GATE — see this file's docblock. A member is flagged here if it STARTS WITH one of
 * these verbs, which is exactly the shape that missed `postMessage` in round 3 — deliberately
 * left UNCHANGED from round 3 rather than patched to also catch `post`, because patching it
 * would blur the point: this list is not relied on for coverage at all any more, only for a
 * friendlier message alongside the exact-pair allow-list's verdict. `isAllowedCall` below is
 * what actually decides pass/fail.
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

function looksLikeWrite(member: string): boolean {
  return WRITE_VERB_PREFIXES.some((verb) => member.startsWith(verb));
}

/**
 * item 1 (BAL-445 fix-round-4) — THE GATE. The exact `(object, member)` pairs the three guest
 * read actions may call DIRECTLY, on any repository. Anything else fails, with the offending
 * pair named in the message — including a read-shaped name like `getOrCreate` that a
 * read-verb-prefix allow-list would have waved through, and including `postMessage`, which a
 * deny-by-verb-prefix check missed entirely (that is the whole reason this file was rebuilt).
 */
const ALLOWED_REPOSITORY_CALLS: readonly { readonly object: string; readonly member: string }[] = [
  { object: 'meetingFilesRepository', member: 'listByMeeting' },
  { object: 'meetingFilesRepository', member: 'findInMeeting' },
  { object: 'conversationsRepository', member: 'listMessagesPage' },
];

function isAllowedCall(call: { readonly object: string; readonly member: string }): boolean {
  return ALLOWED_REPOSITORY_CALLS.some(
    (allowed) => allowed.object === call.object && allowed.member === call.member
  );
}

/**
 * item 2 (BAL-445 fix-round-4) — every module on the guest read path (the three actions plus
 * the three `lib/meetings` modules they reach), and the EXACT SET of names it may import from
 * `@balo/db`. A bare export like `resolveMeetingContextOwner` has no `Repository.` in its name,
 * so `repositoryMemberCallsOf` cannot see it; this pin is what catches a new one arriving
 * unnoticed. Checked both ways below (unexpected AND stale), so the pin cannot rot into
 * decoration.
 */
const ALLOWED_DB_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'app/join/_actions/list-guest-meeting-files.ts': [
    'isTwoSidedParty',
    'meetingFilesRepository',
    'MEETING_FILE_LIST_LIMIT',
  ],
  'app/join/_actions/get-guest-meeting-file-download.ts': [
    'isTwoSidedParty',
    'meetingFilesRepository',
  ],
  'app/join/_actions/fetch-guest-meeting-thread.ts': ['conversationsRepository'],
  // The resolver. `join-link-never-writes.test.ts` already pins its `meetingGuestsRepository`
  // members from the participation axis; this pin covers the write axis for the same module.
  'lib/meetings/resolve-meeting-guest.ts': ['meetingGuestsRepository', 'Meeting', 'MeetingGuest'],
  // The file-access gate. `resolveMeetingContextOwner` is the bare export named in this file's
  // docblock — pinned here, not invisible to a Repository-shaped scan.
  'lib/meetings/authorize-meeting-file-access.ts': [
    'expertsRepository',
    'meetingContextsRepository',
    'meetingsRepository',
    'partyMembershipsRepository',
    'requestExpertRelationshipsRepository',
    'resolveMeetingContextOwner',
    'Meeting',
  ],
  // The chat anchor / access resolver.
  'lib/meetings/meeting-chat-anchor.ts': [
    'conversationsRepository',
    'engagementsRepository',
    'meetingContextsRepository',
    'requestExpertRelationshipsRepository',
  ],
  // BAL-439 — the guest RECAP gate. A sibling of resolveRecapAccess that composes the shipped
  // guest arm; it calls no repository at all (see ALLOWED_LIB_REPOSITORY_CALLS below).
  'lib/meetings/resolve-guest-recap-access.ts': ['Meeting'],
  // BAL-439 — the guest recap loader. TWO repositories, both artefact reads, both projected.
  'app/join/[token]/recap/_lib/load-guest-recap.ts': [
    'transcriptArtifactsRepository',
    'transcriptsRepository',
  ],
  // BAL-439 — pinned by the NEW coverage assertion below, which is what forced it into view.
  // The join landing reads seven repositories for an unauthenticated external visitor and was
  // pinned on the participation axis only (join-link-never-writes.test.ts) until now.
  'app/join/[token]/page.tsx': [
    'agenciesRepository',
    'companiesRepository',
    'engagementsRepository',
    'expertsRepository',
    'meetingContextsRepository',
    'meetingGuestsRepository',
    'usersRepository',
  ],
};

/**
 * item 4 (BAL-445 fix-round-4) — the exact `(object, member)` pairs EVERY MODULE THE GUEST READ
 * PATH REACHES BEYOND THE ACTIONS THEMSELVES may call, transitively closing the gap the
 * per-action scan cannot see: `fetch-guest-meeting-thread.ts` reaches
 * `conversationsRepository.findByContext` only via `meeting-chat-anchor.ts`. If that ever
 * became `ensureForContext` — BAL-424's exact defect class — a per-file scan of the action
 * alone would never notice.
 *
 * ⚠ BAL-439 GREW THIS MAP PAST "the three `lib/meetings` modules" the name once literally meant
 * — it is keyed on arbitrary `src/`-relative paths, and the guest RECAP path (a page, not an
 * action) is pinned here too, alongside its gate.
 */
const ALLOWED_LIB_REPOSITORY_CALLS: Readonly<
  Record<string, readonly { readonly object: string; readonly member: string }[]>
> = {
  'lib/meetings/resolve-meeting-guest.ts': [
    { object: 'meetingGuestsRepository', member: 'findLiveByTokenHash' },
  ],
  'lib/meetings/authorize-meeting-file-access.ts': [
    { object: 'expertsRepository', member: 'findProfileById' },
    { object: 'partyMembershipsRepository', member: 'getMemberRole' },
    { object: 'requestExpertRelationshipsRepository', member: 'findById' },
    { object: 'requestExpertRelationshipsRepository', member: 'listByRequest' },
    { object: 'meetingContextsRepository', member: 'listByMeeting' },
    { object: 'meetingsRepository', member: 'findById' },
  ],
  'lib/meetings/meeting-chat-anchor.ts': [
    { object: 'engagementsRepository', member: 'findById' },
    { object: 'requestExpertRelationshipsRepository', member: 'findById' },
    { object: 'conversationsRepository', member: 'findByContext' },
    { object: 'conversationsRepository', member: 'listContexts' },
    { object: 'meetingContextsRepository', member: 'listByMeeting' },
  ],
  // ⚠ AN EMPTY PIN IS THE ASSERTION: this gate calls NO repository. It composes two lib modules
  // that do, each pinned in its own right. Any repository call added here fails loudly.
  'lib/meetings/resolve-guest-recap-access.ts': [],
  'app/join/[token]/recap/_lib/load-guest-recap.ts': [
    { object: 'transcriptsRepository', member: 'findByMeetingId' },
    { object: 'transcriptArtifactsRepository', member: 'findByTranscriptAndKind' },
  ],
};

/** Reads and comment-strips a `src/`-relative module, for the two transitive pins above. */
function readModuleCode(rel: string): string {
  const filePath = resolveRouteDir([`src/${rel}`, `apps/web/src/${rel}`]);
  if (filePath === '') {
    throw new Error(
      `guest-read-allowlist.test.ts could not resolve "${rel}" under either candidate root — ` +
        `a renamed file would otherwise make every assertion against it pass vacuously.`
    );
  }
  return codeLinesOf(readFileSync(filePath, 'utf8'));
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

  /**
   * ⚠⚠ THE SUBORDINATION, ENFORCED IN CODE (BAL-445 fix-round-4), NOT JUST IN A COMMENT. This
   * is a regression pin proving the verb-prefix tripwire, ON ITS OWN, still misses the exact
   * threat this file exists to catch — so nobody can "simplify" the exact-pair allow-list away
   * later under the belief the tripwire alone would still cover `postMessage`. It would not.
   * The allow-list below is what has to catch it, and does (see the next describe block).
   */
  it('the verb-prefix tripwire is demonstrably not the gate: it still misses postMessage on its own', () => {
    expect(looksLikeWrite('postMessage')).toBe(false);
  });

  it.each([...GUEST_READ_ALLOWLIST])(
    '%s calls no repository member outside the exact-pair allow-list (BAL-445 fix-round-4, item 1)',
    (rel) => {
      const basename = rel.replace('app/join/_actions/', '');
      const file = scannedActions.find((f) => f.rel === basename);
      expect(file, `${rel} did not resolve under ${ACTIONS_DIR}`).toBeDefined();

      const calls = repositoryMemberCallsOf(file?.code ?? '');
      const disallowed = calls.filter((call) => !isAllowedCall(call));
      expect(
        disallowed,
        `${rel} calls a repository member outside ALLOWED_REPOSITORY_CALLS: ` +
          disallowed
            .map(
              (c) => `${c.object}.${c.member}${looksLikeWrite(c.member) ? ' (write-shaped)' : ''}`
            )
            .join(', ') +
          `. ALLOWED_REPOSITORY_CALLS is an ALLOW-list, not a deny-list (BAL-445 fix-round-4): a ` +
          `deny-by-verb-prefix rule previously missed conversationsRepository.postMessage, the ` +
          `exact threat this guard exists to catch. Guest read actions must never write — see ` +
          `GUEST_READ_ALLOWLIST's docblock and BAL-486.`
      ).toEqual([]);
    }
  );

  it.each(Object.entries(ALLOWED_DB_IMPORTS))(
    '%s imports from @balo/db only its pinned names (BAL-445 fix-round-4, item 2)',
    (rel, allowed) => {
      const code = readModuleCode(rel);
      const used = namedImportsFrom(code, '@balo/db');
      const unexpected = [...new Set(used.filter((name) => !allowed.includes(name)))].sort();
      const stale = [...allowed].filter((name) => !used.includes(name)).sort();
      expect(
        unexpected,
        `${rel} now imports ${unexpected.join(', ')} from @balo/db, which is not on its pinned ` +
          `import set in ALLOWED_DB_IMPORTS. A bare export like resolveMeetingContextOwner has ` +
          `no "Repository." in its name, so the repository-call allow-lists above cannot see ` +
          `it — this pin is what catches a new one arriving unnoticed. If it is genuinely a ` +
          `read, add it here with a one-line justification of what it reads and why it cannot ` +
          `write.`
      ).toEqual([]);
      expect(
        stale,
        `${rel}'s pinned @balo/db import set in ALLOWED_DB_IMPORTS lists ${stale.join(', ')}, ` +
          `which it no longer imports. Prune the pin so it keeps meaning something — or, if ` +
          `this fires because namedImportsFrom stopped parsing this file's import, that is the ` +
          `dead-matcher failure mode this exact-both-ways check exists to catch.`
      ).toEqual([]);
    }
  );

  it.each(Object.entries(ALLOWED_LIB_REPOSITORY_CALLS))(
    '%s calls no repository member outside its pinned exact-pair set (BAL-445 fix-round-4, item 4)',
    (rel, allowed) => {
      const code = readModuleCode(rel);
      const calls = repositoryMemberCallsOf(code);
      const disallowed = calls.filter(
        (call) => !allowed.some((a) => a.object === call.object && a.member === call.member)
      );
      const missing = allowed.filter(
        (a) => !calls.some((call) => call.object === a.object && call.member === a.member)
      );
      expect(
        disallowed,
        `${rel} calls a repository member outside its pinned set in ALLOWED_LIB_REPOSITORY_CALLS: ` +
          disallowed
            .map(
              (c) => `${c.object}.${c.member}${looksLikeWrite(c.member) ? ' (write-shaped)' : ''}`
            )
            .join(', ') +
          `. The guest read path's write guard is transitive by construction, not just ` +
          `per-action: this module is reached from a guest read action, and BAL-424's exact ` +
          `defect class (a read silently becoming ensureX/get-or-create) is what this pin ` +
          `exists to catch here too.`
      ).toEqual([]);
      expect(
        missing,
        `${rel}'s pinned set in ALLOWED_LIB_REPOSITORY_CALLS lists ` +
          missing.map((c) => `${c.object}.${c.member}`).join(', ') +
          `, which no longer appears in the module. Prune the pin — or, if this fires because ` +
          `repositoryMemberCallsOf stopped parsing this file, that is the dead-matcher failure ` +
          `mode this exact-both-ways check exists to catch.`
      ).toEqual([]);
    }
  );

  /**
   * BAL-439, item (c) — WITHOUT THIS, a future guest PAGE (not an action under `_actions/`)
   * could read any repository with no pin at all: this whole file's exact-set-equality guards
   * are keyed on `_actions/*` referencing `resolveMeetingGuestSubject`, and the guest RECAP
   * loader deliberately lives outside `_actions/` (§7 of the plan). This closes that hole by
   * scanning every source file under `app/join` OTHER than `_actions` and requiring every
   * `@balo/db` importer among them to be pinned in `ALLOWED_DB_IMPORTS`.
   */
  it('every app/join module outside _actions that imports @balo/db is pinned (BAL-439)', () => {
    const joinDir = resolveRouteDir(['src/app/join', 'apps/web/src/app/join']);
    const scanned = scanRouteSources(joinDir, 'app/join', ['_actions']);
    expect(scanned.length).toBeGreaterThan(0); // guards the guard
    const unpinned = scanned
      .filter((f) => f.code.includes("from '@balo/db'") || f.code.includes('from "@balo/db"'))
      .map((f) => f.rel)
      .filter((rel) => !Object.hasOwn(ALLOWED_DB_IMPORTS, rel))
      .sort();
    expect(
      unpinned,
      `These app/join modules (outside _actions) import @balo/db but are not pinned in ` +
        `ALLOWED_DB_IMPORTS: ${unpinned.join(', ')}. A page or loader on the guest read path ` +
        `must state its whole @balo/db import set here, exactly like the three lib/meetings ` +
        `modules above.`
    ).toEqual([]);
  });
});
