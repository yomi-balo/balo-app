import { describe, expect, it } from 'vitest';
import { memberNamesOf, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-408 / ADR-1044 — structural invariant for **THE JOIN LINK READS AND STAMPS; IT NEVER
 * CHANGES WHO MAY ATTEND.**
 *
 * `/join/{token}` is reached by clicking a link in an email, so its URL is handled by machines
 * long before a human sees it: Gmail's link proxy, Microsoft Defender Safe Links detonation,
 * Proofpoint/Barracuda rewriting and MDM prefetch all issue unsolicited GETs. And unlike every
 * other token landing on the platform, this token is deliberately **NOT SINGLE-USE** — a guest
 * presents it from a desktop, then a phone, then again to rejoin after a network drop mid-call
 * — so the number of unsolicited fetches per real visit is unbounded rather than one.
 *
 * A GET that MUTATED PARTICIPATION under those conditions would be catastrophic in a way a
 * stray read never is: a scanner detonating an emailed link could revoke a guest's own access,
 * decide an admission nobody chose, or push an expiry — all silently, all attributed to a real
 * user id, and none of them undoable from the guest's side (they have no account). BAL-132's
 * admit/deny lobby, when it lands, must therefore arrive as a POST-only Server Action or an
 * `apps/api` route, never as anything a navigation can reach.
 *
 * ⚠ `meetingGuestsRepository.recordAccess` IS a write, IS on the GET path, and is CORRECT.
 * This invariant is not "the page writes nothing" — it is "the page never changes WHO MAY
 * ATTEND, or FOR HOW LONG". Stating it that narrowly is what keeps it true and enforceable.
 * `access_count` / `last_accessed_at` are documented as SCANNER-INFLATED on the schema itself;
 * inflating a liveness counter is the accepted cost, mutating a grant is not.
 *
 * TWO tests guard this, deliberately, because each survives the other's failure mode:
 *   - `app/join/[token]/page.test.tsx` fires 20 GETs and asserts `revoke` was called ZERO
 *     times, and that a FAILING token produces ZERO `recordAccess` calls. That survives
 *     indirection (a write hidden behind a helper still shows up) but dies the moment someone
 *     swaps the `@balo/db` mock.
 *   - THIS test reads the source and asserts the mutating members are not even referenced.
 *     That survives any mock change but can be dodged by indirection.
 * Neither is redundant; both are cheap.
 *
 * If this test fails: you added a participation mutation to the GET path. Move it into a
 * Server Action under `app/join/_actions/`, or into `apps/api`.
 */

const JOIN_DIR = resolveRouteDir(['src/app/join', 'apps/web/src/app/join']);

/**
 * The WHOLE app router, for the prefetch invariant below. Scoped to `src/app` (not
 * `src/lib`) because `<Link>` lives in route code, and because `lib/auth/route-config.ts`
 * and `@balo/shared/redaction` BOTH legitimately carry the `/join/` prefix as a registry
 * entry — matching them would make the invariant unsatisfiable.
 */
const APP_DIR = resolveRouteDir(['src/app', 'apps/web/src/app']);

/**
 * Excluded IN ADVANCE. BAL-132's admit/deny lobby is the first thing that will legitimately
 * mutate participation from this route, and it must arrive as a POST-only Server Action here
 * (or an `apps/api` route) — scanning it would make this invariant impossible to satisfy,
 * exactly as `/review`'s invariant excludes its own.
 */
const EXCLUDED_DIRS: readonly string[] = ['_actions'];

/**
 * The GET/render path, pinned. Relative to `app/join`, POSIX separators. Pinning is the
 * non-vacuity guard: a directory walk that silently finds nothing passes everything.
 */
const PINNED_GET_PATH_FILES: readonly string[] = [
  'layout.tsx',
  '[token]/page.tsx',
  '[token]/loading.tsx',
  '[token]/error.tsx',
  '[token]/link-not-active.tsx',
  '[token]/_components/access-scope-disclosure.tsx',
  // BAL-132 — the join control and the anonymous lobby segment. ⚠ These are the files the
  // invariant's own docblock ANTICIPATED: the lobby is the first thing that legitimately
  // mutates participation from this route, and it arrives as POST-only Server Actions under
  // `_actions/` (excluded below) with everything else here staying read-only.
  '[token]/join-control.tsx',
  'm/[meetingId]/page.tsx',
  'm/[meetingId]/lobby-client.tsx',
  'm/[meetingId]/loading.tsx',
  'm/[meetingId]/error.tsx',
];

/**
 * The ONLY `meetingGuestsRepository` members the GET path may reach.
 *
 * An ALLOW-list rather than a deny-list of today's four mutators, so a future write member
 * added under ANY name (`transferGuest`, `reissueToken`, `admit`, …) fails here instead of
 * shipping. `recordAccess` is the ONE write on the list and it is justified in the module
 * docblock; the other two are pure reads.
 */
const ALLOWED_GUEST_REPOSITORY_MEMBERS: readonly string[] = [
  'findLiveByTokenHash',
  'listLiveByMeeting',
  'recordAccess',
];

/**
 * The four members that change WHO MAY ATTEND or FOR HOW LONG. Named explicitly — on top of
 * the allow-list — so a failure message says which grant a navigation could have altered,
 * rather than only that an unknown member appeared.
 */
const PARTICIPATION_MUTATORS: readonly string[] = [
  'createMany',
  'revoke',
  'decideAdmission',
  'extendExpiryForMeeting',
];

describe('invariant: the /join/{token} GET path never changes who may attend (BAL-408)', () => {
  const scanned = scanRouteSources(JOIN_DIR, '', EXCLUDED_DIRS);
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects the pinned GET-path files (guards against a vacuous pass)', () => {
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_GET_PATH_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
  });

  it('excludes any _actions POST path from the scan (it is allowed to mutate)', () => {
    expect(scannedPaths.filter((rel) => rel.includes('_actions'))).toEqual([]);
  });

  it('guards the guard: the matcher can see a meetingGuestsRepository call that IS present', () => {
    // If `memberNamesOf` or `codeLinesOf` ever breaks, every assertion below passes
    // vacuously. `page.tsx` legitimately calls three members — prove the very matcher the
    // assertions use finds them.
    const page = scanned.find((file) => file.rel === '[token]/page.tsx');
    expect(page).toBeDefined();
    const members = memberNamesOf(page?.code ?? '', 'meetingGuestsRepository');
    expect(members).toContain('findLiveByTokenHash');
    expect(members).toContain('listLiveByMeeting');
    expect(members).toContain('recordAccess');
  });

  it('no GET-path file references a participation mutator', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const mutator of PARTICIPATION_MUTATORS) {
        if (file.code.includes(`meetingGuestsRepository.${mutator}`)) {
          offenders.push(`${file.rel} → ${mutator}`);
        }
      }
    }
    expect(
      offenders,
      `These files are on the /join/{token} GET path but reference a participation mutator. ` +
        `An emailed URL is fetched by link scanners and prefetchers — and a join token is NOT ` +
        `single-use, so those fetches are unbounded. A GET that mutates could revoke a ` +
        `guest's own access or decide an admission nobody chose. Move the write into a ` +
        `POST-only Server Action under app/join/_actions/, or into apps/api:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('the GET path uses ONLY the allow-listed members of meetingGuestsRepository', () => {
    const used = new Set<string>();
    for (const file of scanned) {
      for (const member of memberNamesOf(file.code, 'meetingGuestsRepository')) {
        used.add(member);
      }
    }
    const disallowed = [...used]
      .filter((member) => !ALLOWED_GUEST_REPOSITORY_MEMBERS.includes(member))
      .sort();
    expect(
      disallowed,
      `The /join/{token} GET path may only use ${ALLOWED_GUEST_REPOSITORY_MEMBERS.join(', ')} ` +
        `on meetingGuestsRepository. It now also uses: ${disallowed.join(', ')}. If that ` +
        `member changes WHO MAY ATTEND or FOR HOW LONG it belongs in a Server Action / ` +
        `apps/api; if it is genuinely a read, add it to ALLOWED_GUEST_REPOSITORY_MEMBERS with ` +
        `a one-line justification.`
    ).toEqual([]);
  });

  /**
   * ⚠ THE BUNDLE FOOTGUN, ENFORCED STRUCTURALLY (memory
   * `reference_balo_db_client_bundle_footgun`). A `'use client'` module that VALUE-imports
   * `@balo/db` drags `postgres` into the browser graph and kills `next build` with "can't
   * resolve 'tls'" — a failure no local typecheck, lint or vitest run catches. This route
   * gains a client component the moment BAL-132 lands, so the rule is pinned NOW rather than
   * discovered on Vercel then.
   */
  it('no client component on this route value-imports @balo/db', () => {
    const offenders = scanned
      // ⚠ BOTH QUOTE STYLES. Prettier normalises to single quotes here, but the directive is
      // a plain string literal that nothing type-checks — a hand-written `"use client"` (or
      // one arriving in a merge from a differently-configured editor) slipped past a
      // single-quote-only check and took the invariant with it.
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.code.includes("from '@balo/db'")
      )
      .map((file) => file.rel);
    expect(
      offenders,
      `These files are client components that value-import @balo/db, which pulls postgres ` +
        `into the browser graph and breaks \`next build\` with "can't resolve 'tls'" — a ` +
        `failure NO local gate catches. Do the read in the RSC and pass plain props:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * ⚠ The token is in the URL because it has to be. A join link is presented repeatedly and
   * from several devices, so a `<Link>` anywhere in the app pointing at `/join/...` would be
   * PREFETCHED by Next on viewport/hover — stamping accesses on links nobody opened, and
   * shipping the token in a `Referer` that the layout's `no-referrer` policy (which governs
   * navigation OUT of this page) does not cover.
   *
   * ⚠⚠ THE SCAN IS THE WHOLE APP ROUTER MINUS `app/join`, WHICH IS THE INVERSE OF WHAT THIS
   * ONCE CHECKED. Scanning only `app/join` searched the one directory in the codebase where
   * nobody would ever write such a link — the risk is a dashboard, an inbox row or a case
   * surface linking a guest straight into their own invitation. `app/join` is EXCLUDED
   * rather than merely uninteresting: it is the destination, and BAL-132 will add relative
   * navigation inside it.
   */
  describe('no <Link> anywhere in the app router points at /join/…', () => {
    const appScanned = scanRouteSources(APP_DIR, '', ['join']);

    it('collects the app router (guards against a vacuous pass)', () => {
      // If the walk finds nothing — a wrong cwd, a renamed directory — every assertion
      // below passes for the wrong reason. Pin a file that is certain to exist.
      expect(appScanned.length).toBeGreaterThan(0);
      expect(appScanned.map((file) => file.rel)).toContain('layout.tsx');
    });

    it('excludes the /join route tree itself from this scan', () => {
      expect(appScanned.filter((file) => file.rel.startsWith('join/'))).toEqual([]);
    });

    it('finds no /join/ URL outside the route', () => {
      const offenders = appScanned
        .filter((file) => file.code.includes('/join/'))
        .map((file) => file.rel);
      expect(
        offenders,
        `These app-router files reference a /join/ URL. Next PREFETCHES a <Link> on ` +
          `viewport/hover, which would stamp an access on a guest link nobody opened and ` +
          `leak the token in a Referer the /join layout's no-referrer policy cannot cover ` +
          `(it governs navigation OUT of that page, not INTO it). A guest reaches their ` +
          `invitation from the email, never from inside Balo:\n  ` +
          offenders.join('\n  ')
      ).toEqual([]);
    });
  });

  it('no GET-path file inside the route hard-codes a /join/ URL either', () => {
    const offenders = scanned
      .filter((file) => file.code.includes('/join/'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These files are inside app/join and hard-code a /join/ URL. Use a relative path; a ` +
        `hard-coded one is how a token ends up interpolated into markup:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});
