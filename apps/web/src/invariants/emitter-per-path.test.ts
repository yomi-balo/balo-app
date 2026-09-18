import { describe, expect, it } from 'vitest';
import { occurrences, resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-568 fix round 2 (G3) — structural invariant: **`auth_session_invalidated` HAS EXACTLY ONE
 * EMITTER PER PATH.**
 *
 * ⚠⚠ WHY THIS FILE EXISTS. The event's own docblock said it fired once per refusal. It did not:
 *
 *   · an **api** refusal emitted in `apps/api`'s `requireAuth` AND again in
 *     `consumeApiAccountRefusal` on the web side — every refused API call counted twice;
 *   · a **page** ejection emitted in `getCurrentUser()` (the root layout) AND again in the
 *     session-sync route.
 *
 * The second one was more than a counting error. `NotificationBell` polls `/api/notifications`
 * every 30s and KEEPS POLLING after a 401, and that route resolves its actor through
 * `getCurrentUser()` — so a suspended user with one open tab produced a *flushing* PostHog call
 * every 30 seconds for the life of the cookie. Exposure is zero today (only a direct database edit
 * can suspend an account) and becomes real the moment an admin suspend screen ships.
 *
 * ⚠ THE RULE, which `lib/auth/account-liveness.ts` also states in prose:
 *
 * | path     | THE ONE EMITTER                                                       |
 * | -------- | --------------------------------------------------------------------- |
 * | `api`    | `apps/api`'s `requireAuth` — out of this tree, so not scanned here     |
 * | `page`   | `app/api/auth/session-sync/route.ts`                                  |
 * | `action` | `assertAccountLive`, or a hand-gated action's own `{ emit: true }`     |
 *
 * Everything else is LOG-ONLY: it keeps its `log.*` line and emits nothing.
 *
 * ⚠ THE WALK IS UNFILTERED AND THE PINS ARE COMPARED, NEVER USED TO FILTER (the BAL-404 lesson).
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

/** The constant every emission goes through — the event name is never written as a bare literal. */
const EVENT_CONSTANT = 'AUTH_SERVER_EVENTS.SESSION_INVALIDATED';

/** The `accountRefusalFor` opt-in that turns a call site into an emitter. */
const EMIT_OPT_IN = 'emit: true';

/**
 * The ONLY `apps/web` modules permitted to emit `auth_session_invalidated`, each with the path it
 * owns and why it — and not a neighbouring layer — is the right place.
 */
const ALLOWED_EMITTERS: readonly { rel: string; path: string; reason: string }[] = [
  {
    rel: 'lib/auth/account-liveness.ts',
    path: 'action (and page, on behalf of the sync route)',
    reason:
      'It DEFINES the emission (`noteAccountRefusal`) and is the one place the `emit` opt-in is honoured. `assertAccountLive` — the action path owner — is here too. Nothing outside this module calls `trackServerAndFlush` for this event directly except the sync route.',
  },
  {
    rel: 'app/api/auth/session-sync/route.ts',
    path: 'page',
    reason:
      'The route that actually EJECTS a refused session: it reads the live row, destroys the cookie and redirects to /login?error=… . Every other page-path refusal hands off to it, so it is the one place a page ejection is observed exactly once.',
  },
];
const ALLOWED_EMITTER_RELS: readonly string[] = ALLOWED_EMITTERS.map((entry) => entry.rel);

/**
 * Seams that CATCH a liveness refusal but must NOT emit, each with the layer that emits instead.
 * Asserted positively: they reference the refusal machinery, and they contain no emission.
 */
const LOG_ONLY_SEAMS: readonly { rel: string; emitterInstead: string }[] = [
  {
    rel: 'lib/auth/session.ts',
    emitterInstead: 'the session-sync route, which is where a refused render actually ejects',
  },
  {
    rel: 'lib/auth/api-account-refusal.ts',
    emitterInstead: "apps/api's requireAuth, where the refusal originates",
  },
  {
    rel: 'app/api/auth/switch-workspace/route.ts',
    emitterInstead: 'the session-sync route it redirects to',
  },
];

const scanned = scanRouteSources(SRC_DIR, '', []);
const fileOf = (rel: string): ScannedFile | undefined =>
  scanned.find((candidate) => candidate.rel === rel);
const emitters = scanned.filter((f) => f.code.includes(EVENT_CONSTANT)).map((f) => f.rel);

describe('invariant: one emitter per path for auth_session_invalidated (BAL-568 / G3)', () => {
  it('E1: scans the tree (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1000);
    expect(emitters.length).toBeGreaterThan(0);
  });

  it('E2: the set of emitting modules is EXACTLY the allowed set, both directions', () => {
    expect([...emitters].sort(REL_COMPARATOR)).toEqual(
      [...ALLOWED_EMITTER_RELS].sort(REL_COMPARATOR)
    );
    expect(emitters).toHaveLength(2);
  });

  it('E3: each allowed emitter has a stated path and a real reason', () => {
    expect(ALLOWED_EMITTERS).toHaveLength(2);
    for (const entry of ALLOWED_EMITTERS) {
      expect(fileOf(entry.rel), `${entry.rel} must be in the scan set`).toBeDefined();
      expect(entry.path.length, `${entry.rel}: name the path it owns`).toBeGreaterThan(0);
      expect(
        entry.reason.length,
        `${entry.rel}: the reason must be a real sentence`
      ).toBeGreaterThan(40);
    }
  });

  /**
   * ⚠ THE LOAD-BEARING HALF. E2 alone would pass if a seam stopped catching refusals altogether;
   * this asserts each log-only seam still RESOLVES a refusal (so it is genuinely on the path) while
   * emitting nothing.
   */
  it('E4: ⚠ every log-only seam still handles refusals, and emits none', () => {
    expect(LOG_ONLY_SEAMS).toHaveLength(3);
    for (const { rel, emitterInstead } of LOG_ONLY_SEAMS) {
      const file = fileOf(rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;

      const handlesRefusals =
        file.code.includes('accountRefusalFor(') || file.code.includes('AccountRefusalCode');
      expect(handlesRefusals, `${rel} must still be on the refusal path`).toBe(true);

      expect(
        occurrences(file.code, EVENT_CONSTANT),
        `${rel} must NOT emit auth_session_invalidated — ${emitterInstead} owns it. ` +
          'Two layers emitting for one refusal is the G3 defect.'
      ).toBe(0);
    }
  });

  /**
   * ⚠ `getCurrentUser` IS THE POLLING SURFACE. `/api/notifications` resolves its actor through it
   * and `NotificationBell` re-polls every 30s after a 401, so an emission here is a per-30-second
   * flushing PostHog call for the life of a suspended user's cookie. Pinned by name, not just by
   * the file-level count above, because that is the specific regression.
   */
  it('E5: ⚠ getCurrentUser resolves refusals WITHOUT the emit opt-in', () => {
    const session = fileOf('lib/auth/session.ts');
    expect(session).toBeDefined();
    if (session === undefined) return;

    expect(session.code).toContain("accountRefusalFor(user.id, { path: 'page' })");
    expect(
      occurrences(session.code, EMIT_OPT_IN),
      'lib/auth/session.ts must not opt into emission — the sync route owns the page path'
    ).toBe(0);
  });

  it('E6: ⚠ the action path DOES still emit — the rule is one emitter, not none', () => {
    const liveness = fileOf('lib/auth/account-liveness.ts');
    expect(liveness).toBeDefined();
    if (liveness === undefined) return;

    // `assertAccountLive` opts in; that is the action path's one emitter.
    expect(liveness.code).toContain("accountRefusalFor(userId, { path: 'action', emit: true })");
    expect(liveness.code).toContain(EVENT_CONSTANT);
  });

  it('E7: ⚠ the hand-gated actions that own their own refusal still emit', () => {
    // These have no chokepoint to fold into, so each is the ONLY layer that sees its refusal —
    // which makes each of them the one emitter for that refusal, not a duplicate.
    const HAND_GATED = [
      'lib/auth/actions/complete-onboarding.ts',
      'lib/auth/actions/update-timezone.ts',
      'lib/auth/actions/join-matched-company.ts',
      'lib/auth/actions/request-join-company.ts',
      'lib/auth/actions/name-workspace-and-complete.ts',
      'lib/auth/actions/resolve-expert-agency.ts',
      'lib/auth/actions/resolve-onboarding-company.ts',
      'app/review/_actions/submit-token-review.ts',
    ];
    expect(HAND_GATED).toHaveLength(8);
    for (const rel of HAND_GATED) {
      const file = fileOf(rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(
        file.code.includes(EMIT_OPT_IN),
        `${rel} is the only layer that sees its own refusal, so it must emit it`
      ).toBe(true);
    }
  });
});
