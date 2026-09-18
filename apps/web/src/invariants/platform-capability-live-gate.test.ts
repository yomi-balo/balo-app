import { describe, expect, it } from 'vitest';
import {
  hasUseServerDirective,
  occurrences,
  resolveRouteDir,
  scanRouteSources,
  type ScannedFile,
} from './_source-scan';

/**
 * BAL-558 — structural invariant: **EVERY `apps/web` SERVER ACTION THAT SESSION-GATES ON A
 * PLATFORM CAPABILITY ALSO LIVE-GATES IT, UNLESS IT IS NAMED AND ARGUED HERE.**
 *
 * `hasPlatformCapability(user, TOKEN)` reads the SEALED SESSION, which can be up to seven days
 * stale (`checkSessionDrift` only repairs it on a page RENDER; a Server Action POSTs straight to
 * its own endpoint, so no render runs first). `actorHoldsPlatformCapability` re-reads the LIVE
 * row and is the actual revocation boundary (BAL-560 R3). A mutation that stops at the session
 * gate silently honours a capability that was revoked days ago.
 *
 * ⚠ THE WALK IS UNFILTERED; THE ALLOWLIST IS COMPARED, NEVER USED TO FILTER. BAL-404 (#303)
 * documented the trap: a `PINNED_FILES` set-equality assertion against a walk that was FILTERED
 * through a hardcoded allow-list first is VACUOUS, because the collected set can never contain an
 * unexpected file. This invariant walks every non-test `.ts`/`.tsx` file under `apps/web/src`
 * first, classifies each one in memory, and THEN compares the resulting violator set against the
 * allowlist — so a new violator dropped in anywhere is collected and fails set equality loudly.
 *
 * ⚠ IT KEYS ON `hasPlatformCapability(` — the PLATFORM axis only. ADR-1029's membership axis
 * (`hasCapability`) and engagement axis (`hasEngagementCapability`) never match this scan; they
 * have their own gates and invariants.
 *
 * ⚠ SUBSTRING / LEXICAL, NOT A TYPE CHECKER. An aliased import
 * (`import { hasPlatformCapability as h }`) evades this scan. This is a stated limitation, not
 * solved here — consistent with every sibling invariant in this directory.
 *
 * ⚠⚠ BLIND SPOT: AN ACTION GATING THROUGH A SHARED HELPER NAMES NEITHER CALL, SO THIS SCAN
 * CANNOT SEE IT. Five helpers in this tree wrap the two-call sequence and are themselves
 * `inScope` (proven by A2 below), but their CALLERS — the actions that invoke them — name
 * neither `hasPlatformCapability(` nor `actorHoldsPlatformCapability(` and are therefore
 * invisible to this walk:
 *   · `engagements/[id]/_actions/engagement-lifecycle-shared.ts` — covered by
 *     `engagement-lifecycle-shared.test.ts` (its `gateAdminEngagement` describe block pins the
 *     BAL-560/F2 live-revoked case).
 *   · `engagements/[id]/_actions/action-item-action-shared.ts` — covered by
 *     `action-item-actions.test.ts` (the caller test file; it pins the BAL-560/F2 live-revoked
 *     case for `MANAGE_ANY_ENGAGEMENT_ACTION_ITEM`).
 *   · `admin/applications/_actions/_shared/require-application-reviewer.ts` — covered by
 *     `require-application-reviewer.test.ts`.
 *   · `projects/[requestId]/_actions/_shared/require-request-staff-capability.ts` — covered by
 *     `request-staff-capability-gated.test.ts`.
 *   · `admin/staff-access/_actions/_shared/require-staff-access-manager.ts` — covered by
 *     `require-staff-access-manager.test.ts`, `save-staff-access.test.ts` and
 *     `find-staff-candidate.test.ts`.
 * Passing THIS invariant is NOT evidence those actions are live-gated — their own coverage is.
 *
 * ⚠ RENDER-TIME LOADERS OUTSIDE `_actions`/`'use server'` (pages, `_lib`) are OUT OF SCOPE by
 * design: `checkSessionDrift` repairs a stale cookie before a render runs, so a page component
 * reading `hasPlatformCapability` directly is not the revocation gap this invariant exists to
 * close.
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

// SonarCloud S2871 — a bare `.sort()` coerces to string and orders by UTF-16 code unit; these
// are POSIX-style relative paths, so `localeCompare` is a stable, locale-independent comparator.
const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

const SESSION_GATE = 'hasPlatformCapability(';
const LIVE_GATE = 'actorHoldsPlatformCapability(';

/** In scope: a Server Action directory, OR a file whose first statement is `'use server'`. */
const inScope = (f: ScannedFile): boolean =>
  f.rel.split('/').includes('_actions') || hasUseServerDirective(f.raw);
const callsSessionGate = (f: ScannedFile): boolean => f.code.includes(SESSION_GATE);
const callsLiveGate = (f: ScannedFile): boolean => f.code.includes(LIVE_GATE);
/**
 * ⚠⚠ FIX ROUND 1, SEC-L1 — COUNTS, NOT PRESENCE. A file with `hasPlatformCapability(` used to
 * pass merely by ALSO containing `actorHoldsPlatformCapability(` anywhere — a string literal, or
 * a second action in the same multi-export file that is live-gated while a first one is not. A
 * file with two session-gated actions and only one live-gated action must still be a violator.
 * The rule is therefore a per-file COUNT comparison: more session-gate calls than live-gate
 * calls means at least one of them is ungated.
 *
 * ⚠ REMAINING LIMITS, still true of a lexical/substring scan:
 *   - a string literal containing either call's text still counts, same as before;
 *   - an aliased import (`import { hasPlatformCapability as h }`) evades the scan entirely;
 *   - the rule counts CALLS, it does not associate which action each call belongs to — a file
 *     with three session-gate calls and three live-gate calls passes even if the pairing is
 *     wrong (e.g. two live gates on one action and none on another that also session-gates).
 */
const isLiveGateViolator = (f: ScannedFile): boolean =>
  inScope(f) && occurrences(f.code, SESSION_GATE) > occurrences(f.code, LIVE_GATE);

/**
 * The seven measured exceptions, each with its reason and a `proof` substring the reason
 * genuinely rests on (verified against the file's own code before pinning).
 */
const ALLOWLIST: readonly { rel: string; reason: string; proof: string }[] = [
  {
    rel: 'app/(dashboard)/admin/_actions/load-more-admin-alerts.ts',
    reason:
      'Read-only pagination loader; a stale read shows rows seen one render ago and grants nothing — no security boundary a live read would add.',
    proof: 'listOpenPage(',
  },
  {
    rel: 'app/(dashboard)/admin/health/capture/_actions/load-more-capture-health.ts',
    reason:
      'Read-only pagination loader, same reasoning as the admin-alerts loader above: a stale read grants nothing.',
    proof: 'captureHealthRepository.listPage(',
  },
  {
    rel: 'app/(dashboard)/admin/lookup/_actions/fetch-lookup-timeline.ts',
    reason: 'Read-only loader, same reasoning: a stale read shows data the caller already saw.',
    proof: 'loadLookupTimeline(',
  },
  {
    rel: 'app/(dashboard)/admin/lookup/_actions/fetch-lookup-money-block.ts',
    reason:
      'Read-only loader; the api resolves the axis from a LIVE row on its own side of the seam (D6), so the boundary already exists downstream.',
    proof: 'fetchAdminSessionMoneyBlock(',
  },
  {
    rel: 'app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite.ts',
    reason:
      'Read-only typeahead over the PUBLIC GET /experts/search seam (no auth preHandler, only a fail-open rate limit); the invite it feeds (invite-experts.ts) IS live-gated.',
    proof: 'searchExperts(',
  },
  {
    rel: 'app/dev/_actions/fast-forward.ts',
    reason:
      'Dev-only: a NODE_ENV allow-list refusal runs before the capability check, and its nested staff actions (invite-experts.ts, request-proposal-as-admin.ts) run their own live gate.',
    proof: 'FAST_FORWARD_ALLOWED_NODE_ENVS.includes(',
  },
  {
    rel: 'lib/auth/actions/impersonation.ts',
    reason:
      'Performs its OWN live re-read of the actor via findForSessionSync — the original shape this whole invariant generalises from.',
    proof: 'findForSessionSync(actor.id)',
  },
];
const ALLOWLIST_RELS: readonly string[] = ALLOWLIST.map((entry) => entry.rel);

describe('invariant: every session-gated platform capability check is ALSO live-gated, or named here (BAL-558)', () => {
  const scanned = scanRouteSources(SRC_DIR, '', []);
  const violators = scanned.filter(isLiveGateViolator).map((f) => f.rel);

  it('A1: scans the tree (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1000);
    expect(scanned.filter(inScope).length).toBeGreaterThan(150);
  });

  it('A2: both scope arms work — the `_actions` dir arm, and the `use server` directive arm', () => {
    const sharedHelperRels = [
      'app/(dashboard)/engagements/[id]/_actions/engagement-lifecycle-shared.ts',
      'app/(dashboard)/engagements/[id]/_actions/action-item-action-shared.ts',
      'app/(dashboard)/admin/applications/_actions/_shared/require-application-reviewer.ts',
      'app/(dashboard)/projects/[requestId]/_actions/_shared/require-request-staff-capability.ts',
      'app/(dashboard)/admin/staff-access/_actions/_shared/require-staff-access-manager.ts',
    ];
    for (const rel of sharedHelperRels) {
      const file = scanned.find((candidate) => candidate.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(inScope(file), `${rel} must be in scope via the _actions dir arm`).toBe(true);
      expect(hasUseServerDirective(file.raw), `${rel} is not itself 'use server'`).toBe(false);
    }

    const impersonation = scanned.find((f) => f.rel === 'lib/auth/actions/impersonation.ts');
    expect(
      impersonation,
      'lib/auth/actions/impersonation.ts must be in the scan set'
    ).toBeDefined();
    if (impersonation !== undefined) {
      expect(hasUseServerDirective(impersonation.raw)).toBe(true);
      expect(inScope(impersonation)).toBe(true);
    }
  });

  it('A3: the detection finds real callers', () => {
    const sessionGated = scanned.filter((f) => inScope(f) && callsSessionGate(f));
    const liveGated = scanned.filter((f) => inScope(f) && callsSessionGate(f) && callsLiveGate(f));
    expect(sessionGated.length).toBeGreaterThanOrEqual(20);
    expect(liveGated.length).toBeGreaterThanOrEqual(15);
    expect(sessionGated.map((f) => f.rel)).toContain(
      'app/(dashboard)/projects/[requestId]/_actions/override-balo-fee.ts'
    );
    expect(liveGated.map((f) => f.rel)).toContain(
      'app/(dashboard)/projects/[requestId]/_actions/override-balo-fee.ts'
    );
  });

  it('A4: no UNEXPECTED violator', () => {
    const unexpected = violators.filter((rel) => !ALLOWLIST_RELS.includes(rel));
    expect(
      unexpected,
      'A file session-gates a platform capability without live-gating it. Add ' +
        '`actorHoldsPlatformCapability(...)`, or add it to ALLOWLIST here with a reason.'
    ).toEqual([]);
  });

  it('A5: no STALE allowlist entry', () => {
    const stale = ALLOWLIST_RELS.filter((rel) => !violators.includes(rel));
    expect(stale, 'An allowlisted file is no longer a violator — remove its entry.').toEqual([]);
  });

  it('A6: exact size — the violator set IS the allowlist, both directions', () => {
    expect([...violators].sort(REL_COMPARATOR)).toEqual([...ALLOWLIST_RELS].sort(REL_COMPARATOR));
    expect(violators).toHaveLength(7);
  });

  it('A7: each allowlist reason is backed by source', () => {
    expect(ALLOWLIST).toHaveLength(7);
    for (const entry of ALLOWLIST) {
      const file = scanned.find((candidate) => candidate.rel === entry.rel);
      expect(file, `${entry.rel} must be in the scan set`).toBeDefined();
      expect(entry.reason.length).toBeGreaterThan(20);
      if (file === undefined) continue;
      expect(
        file.code.includes(entry.proof),
        `${entry.rel}: proof "${entry.proof}" not found in code`
      ).toBe(true);
    }
  });

  it('A8: guards the guard — the classifier reacts to the shape it claims to detect', () => {
    const decoyViolator: ScannedFile = {
      rel: 'app/x/_actions/decoy.ts',
      code: 'if (!hasPlatformCapability(u, T)) return;',
      raw: "'use server';",
    };
    expect(isLiveGateViolator(decoyViolator)).toBe(true);

    const decoyFixed: ScannedFile = {
      rel: 'app/x/_actions/decoy.ts',
      code: 'if (!hasPlatformCapability(u, T)) return; await actorHoldsPlatformCapability(u.id, T);',
      raw: "'use server';",
    };
    expect(isLiveGateViolator(decoyFixed)).toBe(false);

    const decoyOutOfScope: ScannedFile = {
      rel: 'lib/x.ts',
      code: 'if (!hasPlatformCapability(u, T)) return;',
      raw: 'export function x() {}',
    };
    expect(isLiveGateViolator(decoyOutOfScope)).toBe(false);

    // FIX ROUND 1, SEC-L1 — a multi-action file with TWO session-gate calls and only ONE
    // live-gate call must still be a violator: one of the two actions is ungated. This is the
    // shape the old presence-only check missed.
    const decoyPartiallyLiveGated: ScannedFile = {
      rel: 'app/x/_actions/decoy.ts',
      code:
        'if (!hasPlatformCapability(u, T)) return; await actorHoldsPlatformCapability(u.id, T); ' +
        'if (!hasPlatformCapability(u, T2)) return;',
      raw: "'use server';",
    };
    expect(isLiveGateViolator(decoyPartiallyLiveGated)).toBe(true);
  });
});
