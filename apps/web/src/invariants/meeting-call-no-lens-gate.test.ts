import { describe, expect, it } from 'vitest';
import {
  codeLinesOf,
  pushRemainderAfterClose,
  resolveRouteDir,
  scanRouteSources,
  type ScannedFile,
} from './_source-scan';

/**
 * BAL-435 / ADR-1029 / ADR-1046 — structural invariant for **THE CALL SURFACE GATES ON THE
 * SERVER'S VERDICT, NEVER ON A VIEW.**
 *
 * ── ⚠⚠ WHY THIS IS A PINNED TEST AND NOT A CODE COMMENT ─────────────────────────────────────
 *
 * The design prototype this feature is built from gates end-for-everyone on
 * `lens === 'expert'` (`balo-in-meeting-ui.jsx:169`). Ending a call for everyone resolves on the
 * SERVER's per-actor verdict — which arrives here as a boolean on the validated grant.
 * `activeMode` is a view toggle and is NEVER an authorization input (ADR-1029).
 *
 * The prototype is the source of truth for the LAYOUT of this surface, so anyone implementing the
 * next slice of it (BAL-436's People panel, BAL-437's chat) reads that file and finds the wrong
 * gate written down in it. A comment saying "don't do that" sits in a file they may never open.
 * This test fails their build.
 *
 * ── ⚠⚠ BAL-134 / ADR-1049 (D3/D4) CHANGED THIS INVARIANT'S **SUBJECT**, NOT ITS INTENT ───────
 *
 * The verdict the End control reads is now `canEndMeeting`, and **`isOwner` is FORBIDDEN from
 * gating it** — a second forbidden token beside the view-shaped ones, for a different reason.
 *
 * `isOwner` is `hasEngagementCapability(HOST_MEETINGS)` and it is the ONE input to the Daily
 * `is_owner` meeting-token property (`join-meeting.ts` → `meeting-tokens.ts`). ADR-1049 gives end
 * authority to the CLIENT PRINCIPAL as well — the party whose per-minute spend is running — and
 * the only safe way to say that is a SECOND grant field. Widening `isOwner` to cover the paying
 * side would mint vendor-level Daily owner tokens (eject, recording control) for clients, which
 * no ADR authorizes. So `canEndMeeting = isOwner || clientPrincipal`, composed server-side in
 * `authorize-end-meeting.ts`, and it reaches a Daily token nowhere.
 *
 * ⚠ THE FAILURE MODE THIS PINS IS A **PLAUSIBLE REFACTOR**, not a typo. Over today's shipped role
 * map the two booleans agree in most fixtures, so "they're always the same — merge them" reads as
 * tidying. It is a privilege escalation in one direction and a lockout in the other. The rule is
 * therefore structural: the two End-control files below may not mention `isOwner` AT ALL.
 *
 * ⚠ AND IT IS SCOPED TO THOSE TWO FILES ON PURPOSE. `isOwner` is entirely legitimate elsewhere in
 * this subtree — `meeting-call-surface.tsx` and `validate-grant.ts` carry it as a grant field,
 * `meeting-frame-impl.tsx` hands it to the analytics `is_owner` property and `participant-tile`
 * reads Daily's own per-participant `owner` flag. A subtree-wide ban would assert a rule nobody
 * agreed to and would be deleted rather than obeyed.
 *
 * ⚠ SCOPED TO THIS SUBTREE ONLY. The repo-wide version of this rule is **BAL-438**; pinning it
 * here first is deliberate, because this is the surface where the wrong gate is already written
 * down in the design input.
 *
 * ── WHAT ELSE IT HOLDS, AND WHY EACH ONE IS HERE ────────────────────────────────────────────
 *
 *   · **No `aria-busy`.** It SUPPRESSES the announcements the join surface's live regions exist
 *     to make — a screen-reader user was admitted to a call and heard nothing. That defect has
 *     already shipped once on this exact surface, three lines below a docblock forbidding it.
 *   · **No `@daily-co` import at the seam.** Two of the three mounts are the PUBLIC `/join/*`
 *     routes, so a static vendor import in `meeting-call-surface.tsx` drags the whole Daily
 *     bundle into the initial chunk of an emailed link opened on a phone. A `dynamic()` boundary
 *     is trivially undone by one careless value import, and no local gate would notice.
 *   · **No `@balo/db` value import.** A client component that value-imports it pulls `postgres`
 *     into the browser graph and kills `next build` with "can't resolve 'tls'" — a failure NO
 *     local typecheck, lint or vitest run catches (`reference_balo_db_client_bundle_footgun`).
 *   · **No `@/lib/logging` in a client module.** It is bare `pino` + `AsyncLocalStorage` and
 *     carries no `server-only` marker to stop the mistake.
 *
 * If this test fails: you gated a control on a view instead of on the grant, or you re-coupled
 * the vendor bundle to the public seam. Neither has a safe workaround — fix the code.
 */

const COMPONENTS_DIR = resolveRouteDir([
  'src/components/balo/meetings',
  'apps/web/src/components/balo/meetings',
]);

const CALL_ROUTE_DIR = resolveRouteDir(['src/app/(call)', 'apps/web/src/app/(call)']);

/**
 * ⚠ `lib/meetings` IS IN SCOPE TOO — it holds `validate-grant.ts`, `meeting-route-context.tsx`,
 * `back-to-context.ts`, `waiting-subject.ts` and `member-join-envelope.ts`, i.e. where the grant,
 * the route context and the "who is missing" decision actually live. A gate written there is
 * exactly as wrong as one written in a component, and the scan used to stop at the component and
 * route trees.
 */
const LIB_DIR = resolveRouteDir(['src/lib/meetings', 'apps/web/src/lib/meetings']);

/**
 * ⚠⚠ AN **ALLOW-LIST**, NOT THE WHOLE DIRECTORY, AND THE REASON IS NOT CONVENIENCE.
 *
 * `lib/meetings` is SHARED: it also holds BAL-388's recap view model (`recap-view-types.ts`,
 * `resolve-recap-access.ts`), whose `lens` is a legitimate VIEW selector — ADR-1029's rule is
 * that a lens gates a VIEW and a capability gates a MUTATION, so those files are correct — and
 * BAL-132's `join-api-client.ts`, which is `server-only` and therefore legitimately imports
 * `@/lib/logging`. Sweeping the directory whole would assert THIS surface's rules over another
 * ticket's code and fail on both, which is how a structural test gets deleted instead of obeyed.
 * The repo-wide version of the rule is BAL-438's.
 *
 * ⚠ EVERY FILE THIS TICKET ADDS TO `lib/meetings` BELONGS ON THIS LIST. The pinned-files test
 * below is what stops a new one being silently unscanned.
 */
const CALL_LIB_FILES: ReadonlySet<string> = new Set([
  'back-to-context.ts',
  'format-scheduled-start.ts',
  'gallery-grid.ts',
  'is-meeting-call-path.ts',
  'meeting-breakpoints.ts',
  'meeting-route-context.tsx',
  'member-join-envelope.ts',
  'member-join-retry.ts',
  'order-tiles.ts',
  'resolve-stage.ts',
  'validate-grant.ts',
  'waiting-copy.ts',
  'waiting-subject.ts',
  // ── BAL-436, the side panel's shared modules ────────────────────────────────────────
  //
  // ⚠ `guests-api-client.ts` IS DELIBERATELY ABSENT, on exactly the grounds this allow-list
  // exists for: it is `server-only` and therefore legitimately imports `@/lib/logging`, the
  // same carve-out `join-api-client.ts` already has. Every OTHER new module is here.
  'guest-roster.ts',
  'guests-copy.ts',
  'guests-poll.ts',
  'join-link.ts',
  'meeting-panels.ts',
  'present-guest-ids.ts',
  // ── BAL-134, the meeting-lifecycle mirror ───────────────────────────────────────────
  //
  // ⚠ `meeting-lifecycle-client.ts` IS DELIBERATELY ABSENT, on exactly the grounds
  // `guests-api-client.ts` and `join-api-client.ts` already are: it carries `import
  // 'server-only'` and therefore legitimately imports `@/lib/logging` (and resolves the viewer's
  // Bearer from the iron-session, which is why it must never reach the browser at all). Every
  // OTHER module this ticket adds to `lib/meetings` is here.
  'meeting-state.ts',
  'top-bar-clock.ts',
  'use-meeting-state-poll.ts',
  // ── BAL-437, in-call chat and reactions ─────────────────────────────────────────────
  //
  // ⚠ `meeting-chat-anchor.ts` IS DELIBERATELY ABSENT, on exactly the grounds this allow-list
  // exists for: it is `server-only`, it legitimately value-imports `@balo/db`, and it reaches
  // `@/lib/logging` transitively through the gate it composes — the same carve-out
  // `guests-api-client.ts` and `join-api-client.ts` already hold. It is therefore NOT pinned
  // below either; the four Server Actions that call it ARE, and none of them may name the
  // engagement-axis seam.
  //
  // ⚠ `call-action-entry.ts` IS HERE AND NOT CARVED OUT: unlike `meeting-chat-anchor.ts` it
  // imports NOTHING but `zod` — no `@balo/db`, and deliberately not `@/lib/logging` (which is
  // why it narrows errors itself rather than calling `errorMessage`). It is scannable, so it is
  // scanned.
  'call-action-entry.ts',
  'meeting-reactions.ts',
  // ── BAL-403, the in-call balance slot ───────────────────────────────────────────────
  // ⚠ BOTH LISTS, ALWAYS — a name left off CALL_LIB_FILES is silently unscanned (a false
  // green); a name left off PINNED_FILES fails nothing. Neither module names `lens`: the
  // DrawdownState's `lens` field is read OUTSIDE this tree, in
  // components/balo/credit/in-call-balance-panel.tsx, deliberately — see below.
  'drawdown-auto-open.ts',
  'use-drawdown-poll.ts',
  // ── BAL-409, client-initiated reschedule ────────────────────────────────────────────
  //
  // ⚠ `member-join-path.ts` AND `reschedule-api-client.ts` ARE DELIBERATELY ABSENT, on
  // exactly the grounds `guests-api-client.ts`, `meeting-lifecycle-client.ts` and
  // `meeting-chat-anchor.ts` already are: both carry `import 'server-only'` (`member-
  // join-path.ts` for the `/join/` prefetch-scan reason its own docblock states;
  // `reschedule-api-client.ts` because it resolves the viewer's Bearer from the
  // iron-session) and neither belongs in a browser bundle, so neither is scanned here.
  // Neither file names `lens` in any case.
  //
  // ── BAL-445 — the guest read arm ────────────────────────────────────────────────────
  //
  // ⚠ `resolve-meeting-guest.ts` IS DELIBERATELY ABSENT, on exactly the grounds every other
  // carve-out above is: it carries `import 'server-only'`, it value-imports `@balo/db`, and
  // it imports `@/lib/logging` — the same shape `guests-api-client.ts`,
  // `meeting-lifecycle-client.ts`, `meeting-chat-anchor.ts`, `member-join-path.ts` and
  // `reschedule-api-client.ts` already hold. It must never reach a browser bundle. If you are
  // unsure whether a name belongs on this list, the rot guard below decides it: a name here
  // must resolve to a real, scannable file — `resolve-meeting-guest.ts` is real but is
  // deliberately not on this list, per the shipped convention those five carve-outs set.
  'panel-capabilities.ts',
  // ── BAL-439 — the guest RECAP gate ──────────────────────────────────────────────────
  //
  // ⚠ `resolve-guest-recap-access.ts` IS **SCANNED, NOT CARVED OUT**, and that is the point:
  // unlike every carve-out above, it imports neither `@balo/db` as a value nor
  // `@/lib/logging` (no logging in this gate at all — see its own docblock), so nothing
  // forces the carve-out. Being scanned here is the structural proof that the guest recap
  // gate can never acquire a lens, an activeMode or a platformRole comparison.
  'resolve-guest-recap-access.ts',
]);

/**
 * ⚠⚠ JSX INLINE COMMENTS TOO — `codeLinesOf` ALONE IS NOT ENOUGH IN A `.tsx` TREE.
 *
 * The shared helper strips `//`, `/* … *\/` and continuation `*` lines, which covers every
 * docblock. It does NOT strip a JSX comment, because that line begins `{/*` rather than `/*` —
 * and this subtree's inline comments quote the forbidden words ON PURPOSE while explaining that
 * they are forbidden ("Never from a lens or a role"). Without this the invariant would fail on
 * its own documentation, which is the classic way a structural test gets deleted instead of
 * obeyed.
 *
 * ⚠ IT IS A SECOND FILTER, NOT A REPLACEMENT: the direction of any error stays the same as the
 * shared helper's — a false ALARM is possible, a false PASS is not, because real code never
 * lives inside `{/* … *\/}`.
 *
 * ⚠⚠ **THE REMAINDER AFTER THE CLOSING `*\/` IS KEPT, AND THAT CLOSED A REAL FALSE PASS.** The
 * first version dropped any line beginning `{/*` WHOLE, so `{/* x *\/} {lens === 'expert' ? … }`
 * — which Prettier preserves verbatim, i.e. not a hypothetical shape — passed all ten assertions
 * below while containing the exact token they exist to forbid. The docblock claimed "a false
 * ALARM is possible, a false PASS is not"; it is now true.
 *
 * ⚠ NO REGEX, deliberately, matching `_source-scan`'s own rule (S5852).
 */
function stripJsxComments(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      inBlock = false;
      pushRemainderAfterClose(kept, line, close);
      continue;
    }
    if (line.startsWith('{/*')) {
      const close = line.indexOf('*/', 3);
      if (close === -1) {
        inBlock = true;
        continue;
      }
      pushRemainderAfterClose(kept, line, close);
      continue;
    }
    kept.push(raw);
  }
  return kept.join('\n');
}

interface CallSource extends ScannedFile {
  /** `code` with JSX comments removed as well. */
  readonly jsx: string;
}

function scanCallTree(): CallSource[] {
  return [
    ...scanRouteSources(COMPONENTS_DIR, 'components', []),
    ...scanRouteSources(CALL_ROUTE_DIR, 'app/(call)', []),
    ...scanRouteSources(LIB_DIR, 'lib/meetings', []).filter((file) =>
      CALL_LIB_FILES.has(file.rel.slice('lib/meetings/'.length))
    ),
  ].map((file) => ({ ...file, jsx: stripJsxComments(file.code) }));
}

/**
 * The files that MUST be in the scan. Pinning is the non-vacuity guard: a directory walk that
 * silently finds nothing (a wrong cwd, a renamed folder) passes every assertion below.
 */
const PINNED_FILES: readonly string[] = [
  'components/meeting-call-surface.tsx',
  'components/meeting-frame.tsx',
  'components/meeting-frame-impl.tsx',
  'components/leave-control.tsx',
  'components/meeting-toolbar.tsx',
  'components/meeting-top-bar.tsx',
  'components/participant-tile.tsx',
  'components/prejoin.tsx',
  'components/waiting-stage.tsx',
  'app/(call)/layout.tsx',
  'app/(call)/meetings/[meetingId]/call/page.tsx',
  'app/(call)/meetings/[meetingId]/call/error.tsx',
  'app/(call)/meetings/[meetingId]/call/loading.tsx',
  'app/(call)/meetings/[meetingId]/call/_components/call-client.tsx',
  'lib/meetings/validate-grant.ts',
  'lib/meetings/meeting-route-context.tsx',
  'lib/meetings/back-to-context.ts',
  'lib/meetings/waiting-subject.ts',
  'lib/meetings/member-join-envelope.ts',
  // ── BAL-436 — the side panel. ⚠ PINNED **AND** ALLOW-LISTED: the allow-list test above
  // fails loudly if a name does not resolve, but a MISSING name fails nothing, so a new
  // module left off `CALL_LIB_FILES` would simply be unscanned. Both lists, always.
  'components/meeting-side-panel.tsx',
  'components/people-panel.tsx',
  'components/people-panel-row.tsx',
  'components/lobby-queue-row.tsx',
  'components/files-panel.tsx',
  'components/files-panel-row.tsx',
  'lib/meetings/guest-roster.ts',
  'lib/meetings/guests-poll.ts',
  'lib/meetings/guests-copy.ts',
  'lib/meetings/join-link.ts',
  'lib/meetings/meeting-panels.ts',
  'lib/meetings/present-guest-ids.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-guests.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/invite-meeting-guests.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/decide-guest-admission.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/resend-guest-link.ts',
  // ── BAL-134 — the mirror and the end act. ⚠ BOTH LISTS, ALWAYS: the allow-list assertion
  // above fails loudly on a name that does not resolve, but a name left OFF fails nothing, so an
  // unpinned module would simply drop out of every scan below. BAL-436 set this precedent with
  // its four `_actions/*.ts`; these are the two BAL-134 adds.
  'lib/meetings/meeting-state.ts',
  'lib/meetings/top-bar-clock.ts',
  'lib/meetings/use-meeting-state-poll.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-state.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/end-meeting.ts',
  // ── BAL-437 — in-call chat and reactions. ⚠ PINNED **AND** ALLOW-LISTED, same reasoning as
  // BAL-436's block above: a missing name fails nothing, so an unpinned new module is silently
  // unscanned. ⚠ `chat-panel-list.tsx` is the one that matters most here — it exists BECAUSE
  // `MessageList` takes a prop named `lens`, which this very scan forbids in this directory.
  'components/chat-panel.tsx',
  'components/chat-panel-list.tsx',
  'components/chat-composer.tsx',
  'components/use-meeting-file-upload.tsx',
  'components/use-meeting-realtime.ts',
  'components/reaction-picker.tsx',
  'components/reaction-floaters.tsx',
  'lib/meetings/call-action-entry.ts',
  'lib/meetings/meeting-reactions.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/create-meeting-realtime-token.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/fetch-meeting-thread.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/post-meeting-message.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/send-meeting-reaction.ts',
  // ── BAL-403 — the in-call balance slot. ⚠ PINNED **AND** ALLOW-LISTED, same reasoning as
  // BAL-436/BAL-134/BAL-437 above.
  'lib/meetings/drawdown-auto-open.ts',
  'lib/meetings/use-drawdown-poll.ts',
  'app/(call)/meetings/[meetingId]/call/_actions/get-meeting-drawdown-state.ts',
  // ── BAL-445 — the guest read-only Files + Chat panels. ⚠ PINNED **AND** ALLOW-LISTED
  // (`panel-capabilities.ts`), same reasoning as every block above: a missing name fails
  // nothing, so an unpinned new module is silently unscanned. The two guest panel
  // components live in `components/balo/meetings/` (scanned WHOLE, not filtered by an
  // allow-list), so they need only a PINNED_FILES entry — the non-vacuity guard.
  'components/guest-files-panel.tsx',
  'components/guest-chat-panel.tsx',
  'lib/meetings/panel-capabilities.ts',
  // ── BAL-445 fix-round-1 (F5 / SUGGESTION-3) — `ChatThreadBody` / `FilesPanelBody` moved out
  // of `chat-panel.tsx` / `files-panel.tsx` into their own modules, so the guest panels stop
  // dragging the composer / upload hook into their bundle through module resolution alone.
  // ⚠ PINNED, same reasoning as every block above: a missing name fails nothing.
  'components/chat-thread-body.tsx',
  'components/files-panel-body.tsx',
  // ── BAL-439 — the guest recap gate. ⚠ PINNED **AND** ALLOW-LISTED (`CALL_LIB_FILES` above),
  // same reasoning as every block above: a missing name fails nothing, so an unpinned new
  // module is silently unscanned.
  'lib/meetings/resolve-guest-recap-access.ts',
];

/**
 * ⚠⚠ THE VIEW-SHAPED TOKENS. A control on this surface may resolve on the server's verdict as it
 * arrives on the validated grant, and on nothing else.
 *
 * `role ===` rather than bare `role`: `role` is a legitimate ARIA attribute and a legitimate
 * Daily participant field, so the deny-list names the COMPARISON — which is the shape an
 * authorization decision actually takes.
 */
const VIEW_GATE_TOKENS: readonly string[] = [
  'lens',
  'activeMode',
  'platformRole',
  'role ===',
  "role === '",
];

/**
 * BAL-403 — `DrawdownState` carries a field named `lens` (`drawdown-state.ts:71`). It is
 * **presentational copy selection**, not authorization: the membership gate and the capability
 * branch both run server-side in `get-drawdown-state.ts:63–73`, and the client renders the
 * verdict. Because this scan is a **substring** match with no per-file exemption, the one module
 * that reads that field lives OUTSIDE all three scanned trees, in
 * `components/balo/credit/in-call-balance-panel.tsx` — beside `in-session-panel.tsx`, which
 * already reads it and is already outside the scan. Same resolution BAL-437 reached for
 * `chat-panel-list.tsx` (see its docblock): **avoid the token, never exempt a file.**
 */

/**
 * BAL-134 / ADR-1049 (D4) — ⚠⚠ **THE FILES THAT RENDER THE END CONTROL.** These may name
 * `canEndMeeting` and may NOT name `isOwner`, in code, anywhere. See the module docblock for why
 * merging the two booleans is a real defect rather than a tidy-up.
 */
const END_CONTROL_FILES: readonly string[] = [
  'components/leave-control.tsx',
  'components/meeting-toolbar.tsx',
];

describe('invariant: the call surface never gates on a lens (BAL-435)', () => {
  const scanned = scanCallTree();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects all three trees (guards against a vacuous pass)', () => {
    expect(COMPONENTS_DIR).not.toBe('');
    expect(CALL_ROUTE_DIR).not.toBe('');
    expect(LIB_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
    // ⚠ THE ALLOW-LIST IS NOT ALLOWED TO ROT. Every name on it must resolve to a real file, so a
    // renamed or deleted module fails loudly here instead of quietly dropping out of the scan.
    for (const file of CALL_LIB_FILES) {
      expect(scannedPaths).toContain(`lib/meetings/${file}`);
    }
  });

  it('⚠ guards the guard: the matcher sees tokens that ARE genuinely present', () => {
    // If `scanRouteSources`, `codeLinesOf` or `stripJsxComments` ever breaks, every assertion
    // below passes over zero files or empty strings. Prove the matcher reads real code by
    // finding things these files certainly contain.
    const impl = scanned.find((file) => file.rel === 'components/meeting-frame-impl.tsx');
    const leave = scanned.find((file) => file.rel === 'components/leave-control.tsx');
    expect(impl).toBeDefined();
    expect(leave).toBeDefined();
    expect(impl?.jsx ?? '').toContain("from '@daily-co/daily-react'");
    // ⚠ BAL-134 RETARGETED THIS PROBE from `isOwner` to `canEndMeeting`. It has to name a token
    // the file GENUINELY contains, and `leave-control.tsx` no longer mentions `isOwner` in code —
    // which is now asserted below, so the old probe would have been a permanent false alarm.
    expect(leave?.jsx ?? '').toContain('canEndMeeting');
    expect(leave?.raw ?? '').toContain("'use client'");
  });

  it('⚠ guards the guard: the JSX-comment filter removes ONLY comments', () => {
    // The filter must not be so eager that it eats the code the assertions read. `leave-control`
    // carries both a JSX comment quoting the rule and the real `canEndMeeting` branch.
    const stripped = stripJsxComments(
      codeLinesOf('{/* lens === "expert" */}\nconst a = canEndMeeting;')
    );
    expect(stripped).not.toContain('lens');
    expect(stripped).toContain('canEndMeeting');
  });

  it('⚠⚠ guards the guard: CODE AFTER A CLOSING */ ON THE SAME LINE IS STILL SCANNED', () => {
    // ⚠ THE FALSE-PASS HOLE THIS FILE SHIPPED WITH. Both filters used to drop the whole line, so
    // a forbidden token sitting after a same-line comment was INVISIBLE to every assertion below
    // — and Prettier preserves this exact formatting, so it is not a hypothetical shape.
    const jsx = stripJsxComments("{/* note */} {lens === 'expert' ? <span /> : null}");
    expect(jsx).toContain('lens');

    const block = codeLinesOf("/* note */ if (activeMode === 'expert') { end(); }");
    expect(block).toContain('activeMode');

    // The same, spread across a multi-line block: the CLOSING line's tail is code too.
    const multiline = codeLinesOf('/* opening\n * middle\n */ const platformRole = read();');
    expect(multiline).toContain('platformRole');
  });

  it('⚠⚠ no file gates on a lens, an activeMode, a platformRole or a role comparison', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of VIEW_GATE_TOKENS) {
        if (file.jsx.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These call-surface files reference a VIEW-shaped authorization token. Ending a call for ` +
        `everyone resolves on the SERVER's per-actor verdict — which arrives as the ` +
        `\`canEndMeeting\` boolean on the validated grant. \`activeMode\` is a view toggle and ` +
        `is NEVER an authorization input (ADR-1029). The design prototype gets this wrong at ` +
        `balo-in-meeting-ui.jsx:169; do not copy it:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * BAL-134 / ADR-1049 (D3/D4) — ⚠⚠ **THE END CONTROL GATES ON `canEndMeeting`, AND `isOwner` IS
   * FORBIDDEN FROM GATING IT.** The full reasoning is in the module docblock; the short version
   * is that `isOwner` mints the Daily owner token and `canEndMeeting` does not, so merging them
   * either hands clients vendor-level room powers or locks the paying side out of stopping its
   * own meter.
   *
   * ⚠ TWO HALVES, AND BOTH ARE LOAD-BEARING. The positive half is the non-vacuity guard: a file
   * that gated on NEITHER token would satisfy a bare absence check while rendering an ungated
   * End control.
   */
  it('⚠⚠ the End control resolves on canEndMeeting — and NEVER on isOwner', () => {
    const endControlSources = END_CONTROL_FILES.map((rel) => ({
      rel,
      file: scanned.find((candidate) => candidate.rel === rel),
    }));

    for (const { rel, file } of endControlSources) {
      expect(file, `${rel} is not in the scan — the invariant would pass vacuously`).toBeDefined();
      expect(
        file?.jsx ?? '',
        `${rel} must resolve the End control on the grant's \`canEndMeeting\` verdict.`
      ).toContain('canEndMeeting');
    }

    const offenders = endControlSources
      .filter(({ file }) => (file?.jsx ?? '').includes('isOwner'))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `These End-control files name \`isOwner\`. It is \`hasEngagementCapability(HOST_MEETINGS)\` ` +
        `and the ONE input to the Daily \`is_owner\` token property; \`canEndMeeting\` is ` +
        `\`isOwner || clientPrincipal\`, composed server-side in \`authorize-end-meeting.ts\`, ` +
        `and reaches a Daily token nowhere. Merging them INTO \`isOwner\` mints vendor-level ` +
        `owner tokens (eject, recording control) for the paying side; merging them INTO ` +
        `\`canEndMeeting\` denies the client principal the ability to stop their own per-minute ` +
        `spend. ADR-1049 gives end authority to BOTH parties — that is why there are two ` +
        `booleans, and why neither may stand in for the other:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * BAL-436 (Ruling H2) — ⚠⚠ **THE ENGAGEMENT AXIS IS NOT RESOLVED IN THE BROWSER TIER.**
   *
   * The two invariants that already police this rule elsewhere
   * (`authorize-conversation-context.test.ts`, `authorize-meeting-file-access.test.ts`) are
   * FILE-SCOPED string assertions, each reading only its OWN source. Nothing stopped a new
   * panel file importing `hasEngagementCapability` — the rule was convention, not a gate.
   *
   * It is a gate now, scoped to the same three trees this file already scans. It does not
   * overreach into the repo-wide version, which stays BAL-438's.
   */
  it('⚠⚠ no call-surface file resolves the engagement axis in the browser tier', () => {
    const offenders = scanned
      .filter((file) => file.jsx.includes('hasEngagementCapability'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These call-surface files resolve the ENGAGEMENT axis in the browser tier. The panel ` +
        `reads \`canHost\` off the guests GET payload. **Do not call the web engagement ` +
        `resolver here even though it now exists** (\`lib/authz/engagement.ts\`, opened by ` +
        `BAL-421) — \`canHost\` is already the server's per-actor ` +
        `\`hasEngagementCapability(HOST_MEETINGS)\` verdict for this exact meeting, computed ` +
        `behind the tenancy gate that must run first. A second resolution in the browser tier ` +
        `would be a second expression of one rule, and would run WITHOUT ` +
        `\`authorizeMeetingParticipation\` in front of it:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('⚠⚠ no file carries aria-busy — it SUPPRESSES the announcement it looks like it helps', () => {
    const offenders = scanned.filter((file) => file.jsx.includes('aria-busy')).map((f) => f.rel);
    expect(
      offenders,
      `\`aria-busy\` tells assistive tech to SUPPRESS a live region's announcements. On this ` +
        `surface that means a screen-reader user is admitted to a call and hears NOTHING. It has ` +
        `already shipped here once, three lines below a docblock forbidding it:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('⚠⚠ the SEAM imports nothing from @daily-co — the code-split boundary, held by a test', () => {
    const seam = scanned.find((file) => file.rel === 'components/meeting-call-surface.tsx');
    expect(seam).toBeDefined();
    expect(
      seam?.jsx.includes('@daily-co') ?? true,
      `meeting-call-surface.tsx imports from @daily-co. TWO of its three mounts are the PUBLIC ` +
        `/join/* routes, so a static vendor import here drags the entire Daily bundle into the ` +
        `initial chunk of an emailed link opened on a phone. Every @daily-co import belongs at ` +
        `or below meeting-frame-impl.tsx, behind the dynamic() boundary — including a type-only ` +
        `one, which is erased but re-couples the import graph the moment somebody "tidies" it ` +
        `into a value import.`
    ).toBe(false);
  });

  it('⚠ the dynamic wrapper is vendor-free too — the boundary is meeting-frame-impl', () => {
    const wrapper = scanned.find((file) => file.rel === 'components/meeting-frame.tsx');
    expect(wrapper).toBeDefined();
    expect(wrapper?.jsx ?? '').not.toContain('@daily-co');
  });

  it('⚠ no route file on (call) imports @daily-co either — the seam is the only entry', () => {
    const offenders = scanned
      .filter((file) => file.rel.startsWith('app/(call)') && file.jsx.includes('@daily-co'))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('⚠⚠ no client component value-imports @balo/db (the next build "tls" footgun)', () => {
    const offenders = scanned
      // ⚠ BOTH QUOTE STYLES. Prettier normalises to single quotes, but the directive is a plain
      // string literal that nothing type-checks — a hand-written `"use client"` slipped past a
      // single-quote-only check once already.
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.jsx.includes("from '@balo/db'")
      )
      .map((file) => file.rel);
    expect(
      offenders,
      `These client components value-import @balo/db, which pulls postgres into the browser ` +
        `graph and breaks \`next build\` with "can't resolve 'tls'" — a failure NO local gate ` +
        `catches. Do the read in the RSC and pass plain props:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('⚠⚠ no client module imports @/lib/logging — it is bare pino + AsyncLocalStorage', () => {
    const offenders = scanned
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.jsx.includes("from '@/lib/logging'")
      )
      .map((file) => file.rel);
    expect(
      offenders,
      `\`@/lib/logging\` is bare \`pino\` + \`AsyncLocalStorage\` and is NOT client-safe — and ` +
        `it carries no \`server-only\` marker to stop the mistake. A failure on this surface is ` +
        `observed by the \`meeting_call_*\` analytics events, whose \`reason\` / \`code\` ` +
        `properties name WHICH CHECK FAILED and never the offending data:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * ⚠ NOT PINNED HERE, DELIBERATELY: "the token never reaches an analytics property".
   *
   * A source scan cannot express it honestly. Every candidate matcher is a substring of a
   * legitimate declaration — `meeting-call-surface.tsx` contains both `track(` and `token:`, the
   * latter being its own prop TYPE — so the structural version is a false alarm on day one, and
   * the only way to make it pass is to weaken it until it asserts nothing.
   *
   * It is covered where it can be checked for real instead: `meeting-call-surface.test.tsx`
   * mounts the frame, joins, and serialises the properties of EVERY `track()` call made during a
   * real join, asserting none contains the token, the room url or the participant id. That
   * survives indirection; a grep for `token:` would not.
   */
});
