import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, memberNamesOf, resolveRouteDir, scanRouteSources } from './_source-scan';

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
  // ── BAL-442 — the lobby re-entry affordance + the resume route ─────────────────────────
  //
  // ⚠ THE RESUME ROUTE PERFORMS ZERO DATABASE READS, exactly like `m/[meetingId]/page.tsx`
  // — its own acceptance criterion. That is what makes it trivially satisfy the
  // participation-mutator and allow-list assertions below: there is no
  // `meetingGuestsRepository` reference to find.
  'm/[meetingId]/lobby-reentry.tsx',
  'm/[meetingId]/resume/[token]/page.tsx',
  'm/[meetingId]/resume/[token]/lobby-resume-client.tsx',
  'm/[meetingId]/resume/[token]/loading.tsx',
  'm/[meetingId]/resume/[token]/error.tsx',
  // ── BAL-439 — the guest recap ────────────────────────────────────────────────────────
  //
  // ⚠ These NINE files are the whole recap tree. The two-tier `[token]/_lib/` vs
  // `recap/_lib/` split matches the placement rule in §7 of the plan: the context-label
  // helper is shared by BOTH `[token]/page.tsx` and the recap loader, so it lives at the
  // `[token]/` level; everything recap-specific lives under `recap/`.
  '[token]/_lib/guest-context-label.ts',
  '[token]/recap/[meetingId]/page.tsx',
  '[token]/recap/[meetingId]/loading.tsx',
  '[token]/recap/[meetingId]/error.tsx',
  '[token]/recap/_lib/guest-recap-view-types.ts',
  '[token]/recap/_lib/load-guest-recap.ts',
  '[token]/recap/_components/guest-recap-card.tsx',
  '[token]/recap/_components/guest-recap-summary.tsx',
  '[token]/recap/_components/guest-recap-files.tsx',
  // ── BAL-492 — the guest recap INDEX ─────────────────────────────────────────────────
  '[token]/recap/page.tsx',
  '[token]/recap/loading.tsx',
  '[token]/recap/error.tsx',
  '[token]/recap/_lib/load-guest-recap-index.ts',
  '[token]/recap/_lib/guest-recap-index-view-types.ts',
  '[token]/recap/_lib/envelope-context-types.ts',
  '[token]/recap/_components/guest-recap-index-card.tsx',
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
    // vacuously. `page.tsx` legitimately calls two members directly.
    //
    // ⚠ BAL-445 — `findLiveByTokenHash` MOVED to `lib/meetings/resolve-meeting-guest.ts`,
    // which this scan's roots cannot see (it walks `app/join` only). It is re-pinned on the
    // resolver below rather than dropped — shrinking a non-vacuity guard to make it pass is
    // how a scan becomes decorative.
    const page = scanned.find((file) => file.rel === '[token]/page.tsx');
    expect(page).toBeDefined();
    const members = memberNamesOf(page?.code ?? '', 'meetingGuestsRepository');
    expect(members).toContain('listLiveByMeeting');
    expect(members).toContain('recordAccess');
  });

  it('the extracted guest resolver uses ONLY the allow-listed members too', () => {
    // ⚠ BAL-445 moved the token→row resolution out of the GET path's own tree. The rule
    // follows the code: this module is what `[token]/page.tsx` now calls, so it inherits the
    // same allow-list and the same participation-mutator ban.
    const resolverPath = resolveRouteDir([
      'src/lib/meetings/resolve-meeting-guest.ts',
      'apps/web/src/lib/meetings/resolve-meeting-guest.ts',
    ]);
    expect(resolverPath).not.toBe('');
    const code = codeLinesOf(readFileSync(resolverPath, 'utf8'));
    const members = memberNamesOf(code, 'meetingGuestsRepository');
    expect(members).toContain('findLiveByTokenHash'); // non-vacuity
    expect(members.filter((m) => !ALLOWED_GUEST_REPOSITORY_MEMBERS.includes(m))).toEqual([]);
    for (const mutator of PARTICIPATION_MUTATORS) {
      expect(code).not.toContain(`meetingGuestsRepository.${mutator}`);
    }
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
      .sort((a, b) => a.localeCompare(b));
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
   * BAL-442 fix round (F5) — plan §9.6 #64, silently dropped from the original build: BLOCKER C
   * requires `lobbyPath(...)` to be called ONLY on the SERVER page (`resume/[token]/page.tsx`)
   * and passed down as a plain `destination` string — never called, and never even reachable,
   * from the CLIENT component (`lobby-resume-client.tsx`), because `lib/meetings/join-link.ts`
   * begins `import 'server-only'` and a client component importing from it would fail the build.
   * Extending `PINNED_GET_PATH_FILES` alone does not check this; this is the missing positive
   * assertion.
   */
  it('⚠ BLOCKER C: lobbyPath( is called on the server page, never on the resume client', () => {
    const serverPage = scanned.find((file) => file.rel === 'm/[meetingId]/resume/[token]/page.tsx');
    const client = scanned.find(
      (file) => file.rel === 'm/[meetingId]/resume/[token]/lobby-resume-client.tsx'
    );
    expect(serverPage).toBeDefined();
    expect(client).toBeDefined();
    expect(serverPage?.code).toContain('lobbyPath(');
    expect(client?.code).not.toContain('lobbyPath(');
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
  /**
   * ⚠⚠ A MODULE SPECIFIER IS NOT A URL, AND CONFLATING THEM WOULD MAKE THIS INVARIANT
   * UNSATISFIABLE.
   *
   * BAL-435 mounts `joinAsMemberAction` from the authenticated call route:
   * `import { joinAsMemberAction } from '@/app/join/_actions/join-as-member'`. That string
   * contains `/join/` and is the FIRST legitimate one in the app router — but it is a build-time
   * import of a POST-only Server Action, not an href. Next prefetches nothing from it, no token
   * appears in it, and no navigation can reach it.
   *
   * ⚠ THE EXCLUSION IS THE `@/app/join/` ALIAS PREFIX AND NOTHING WIDER. A real `<Link>` is
   * written `href="/join/…"`, which does NOT begin with the alias — so every shape this
   * invariant exists to catch still fails it. Narrowing further (say, to whole import lines)
   * would let `href={\`/join/${token}\`}` hide on a line that also imports something.
   */
  function withoutActionImports(code: string): string {
    return code.split('@/app/join/').join('@/app/<server-action>/');
  }

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

    it('⚠ guards the guard: the Server-Action exclusion still catches a real href', () => {
      // If `withoutActionImports` were too broad, every assertion below would pass vacuously.
      expect(
        withoutActionImports("import { a } from '@/app/join/_actions/join-as-member';")
      ).not.toContain('/join/');
      expect(withoutActionImports('<Link href="/join/m/abc">')).toContain('/join/');
      expect(withoutActionImports('href={`/join/${token}`}')).toContain('/join/');
    });

    it('finds no /join/ URL outside the route', () => {
      const offenders = appScanned
        .filter((file) => withoutActionImports(file.code).includes('/join/'))
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

/**
 * BAL-439 fix-round-1 / MUST-7 (security F2) — `instrumentation-client.ts` refuses Session
 * Replay outright on a token-bearing landing, and justifies doing so at INIT time (rather than
 * merely scrubbing) by citing this file's own scan: "no <Link> anywhere in the app router
 * points at /join/…". This PR added the FIRST two in-app `<Link>`s that resolve to a `/join/…`
 * URL — `join-control.tsx`'s "View the recap" and `guest-recap-card.tsx`'s "Back to the
 * invitation" — and BOTH pass the scan above only because their `href`s are built by
 * `guestRecapPath` / `guestInvitationPath` in `lib/meetings/join-link.ts`, a module the scan
 * above does not read at all (it greps `<Link>`-bearing source text for the literal `/join/`
 * substring, and neither call site contains it).
 *
 * That leaves the guarantee the Sentry config leans on UNENFORCED going forward: the next
 * `<Link href={guestRecapPath(...)}>` written from a dashboard page would start Replay there
 * (that page is not itself under `/join/`), then soft-navigate into a token URL — and the
 * rrweb META frame carrying the full `data.href` is unreachable by any scrubbing hook (see
 * `instrumentation-client.ts`'s own docblock for why). The fix is a POSITIVE call-site
 * restriction: every CALLER of the two TOKEN-BEARING path builders must live under
 * `app/join/`, or be the `join-link.ts` definition file itself.
 *
 * ⚠ `meetingJoinLinkUrl` IS DELIBERATELY NOT PART OF THIS RESTRICTION. It is a different
 * function with a different risk profile, and its own docblock states why: it is TOKENLESS
 * (the anonymous lobby route, `/join/m/{meetingId}`, admits nobody by itself).
 *
 * ⚠⚠ BAL-498 UPDATE — the "never rendered as an `href`" clause above still HOLDS, and the
 * fix-round-3 amendment below records why an earlier revision of this block was wrong to relax
 * it. `app/(call)/meetings/[meetingId]/call/page.tsx` (BAL-436) passes the URL as a
 * `joinLinkUrl` prop for a "Copy join link" button — its ONE remaining caller today.
 *
 * ⚠⚠ BAL-566 fix round 1 (F1, user ruling J1) CORRECTED A SECOND CALLER THIS PARAGRAPH USED TO
 * NAME: the expert calendar page (BAL-498) used to call `meetingJoinLinkUrl` too and navigate to
 * it from a `<button>` handler for Join, exactly like the copy-link button. That was wrong for a
 * SIGNED-IN member (see `lib/meetings/member-call-path.ts` for the full account), so the calendar
 * — and the dashboard Up next card's row, BAL-566's own net-new surface — now build
 * `memberCallPath` (`/meetings/{id}/call`) instead and navigate to THAT the same way. The safety
 * analysis below is preserved because it still holds for `meetingJoinLinkUrl`'s one remaining
 * caller; it no longer describes the calendar or the dashboard. Why it is safe:
 *   1. TOKENLESS — the id in the URL admits nobody; a host must still explicitly admit.
 *   2. The lobby page (`app/join/m/[meetingId]/page.tsx`) performs ZERO database reads and
 *      renders a byte-identical card for every id — its own acceptance criterion — so even a
 *      prefetch (which cannot happen here anyway; see below) would disclose nothing meeting-
 *      specific.
 *   3. `SENSITIVE_PATH_PREFIXES` (`packages/shared/src/redaction/index.ts`) carries an
 *      explicit `'/join/m/'` entry ordered BEFORE the general `'/join/'` entry, so the meeting
 *      id is redacted wherever a redaction hook actually runs: Axiom/Pino log records, Sentry
 *      event URLs, and the PostHog `$current_url`/`$pathname`/`$referrer` properties that
 *      `sanitizeAnalyticsEvent` rewrites.
 *      ⚠ NARROWED IN FIX ROUND 3 (security WARNING #1). This clause used to claim redaction
 *      "regardless of how the URL reaches the browser". That is true of a URL and FALSE of a
 *      DOM ATTRIBUTE, which no redaction hook in this codebase reaches: PostHog autocapture is
 *      ON and ships `$elements[].attr__href`, which `sanitizeAnalyticsEvent` never walks; and
 *      Sentry `replayIntegration` records rrweb DOM snapshots whose default `maskAttributes`
 *      (`title`, `placeholder`, `aria-label`) does not include `href`. So an `<a href>` on an
 *      authenticated page shipped the meeting id to two external processors un-redacted,
 *      before any click.
 *   4. There is no credential in the URL to leak via `Referer`.
 *   5. The navigation is a HARD DOCUMENT NAVIGATION (`location.assign`), never `next/link` and
 *      never `router.push`. Two things depend on that: Next's prefetch-on-viewport/hover — the
 *      mechanism this whole file exists to prevent for TOKEN-bearing links — never fires; and
 *      `instrumentation-client.ts`'s init-time Replay refusal re-evaluates `onSensitiveLanding`
 *      on the lobby, which a soft navigation would skip.
 * This is deliberately NOT folded into the `guestRecapPath`/`guestInvitationPath` call-site
 * restriction above: that restriction exists because those two builders carry a single-use-
 * adjacent, replayable TOKEN whose exposure (via prefetch, via `Referer`, via Replay) is the
 * hazard. `meetingJoinLinkUrl`'s URL has no token to expose. Two different risk profiles, two
 * different rules — this repository does not need a third.
 */
describe('invariant: guestRecapPath / guestInvitationPath are only called from app/join (BAL-439 MUST-7)', () => {
  // ⚠ THE WHOLE `src` TREE, not just `src/app` — a future caller of these builders could just
  // as easily be written under `src/lib` or `src/components`, and only a scan that is not
  // scoped to the app router would catch it there.
  const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);
  const TOKEN_BEARING_BUILDERS: readonly string[] = [
    'guestRecapPath(',
    'guestInvitationPath(',
    // BAL-492 — the guest recap INDEX's path builder. Carries the same replayable token.
    'guestRecapIndexPath(',
  ];
  const DEFINITION_FILE = 'lib/meetings/join-link.ts';

  const scanned = scanRouteSources(SRC_DIR, '', []);

  it('collects the whole src tree (guards against a vacuous pass)', () => {
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.map((file) => file.rel)).toContain(DEFINITION_FILE);
  });

  it('guards the guard: a real call site is found, and it is under app/join', () => {
    // If this ever finds zero callers, every assertion below passes for the wrong reason —
    // both builders have a live caller today (`[token]/page.tsx` and `guest-recap-card.tsx`).
    const callers = scanned.filter(
      (file) =>
        file.rel !== DEFINITION_FILE &&
        TOKEN_BEARING_BUILDERS.some((builder) => file.code.includes(builder))
    );
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      expect(caller.rel.startsWith('app/join/')).toBe(true);
    }
  });

  it('no caller of guestRecapPath / guestInvitationPath lives outside app/join', () => {
    const offenders = scanned
      .filter((file) => file.rel !== DEFINITION_FILE && !file.rel.startsWith('app/join/'))
      .filter((file) => TOKEN_BEARING_BUILDERS.some((builder) => file.code.includes(builder)))
      .map((file) => file.rel);

    expect(
      offenders,
      `These files call guestRecapPath / guestInvitationPath from OUTSIDE app/join. Session ` +
        `Replay is refused only on landings instrumentation-client.ts recognises as sensitive ` +
        `by URL at Sentry.init() time; a <Link> built from one of these functions on a ` +
        `dashboard page would start Replay there and then soft-navigate into a token URL, ` +
        `where the rrweb META frame carrying the full href is unreachable by any scrubbing ` +
        `hook. Keep every call site under app/join/:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});

/**
 * BAL-498 fix round 3 (security WARNING #1) — the SOURCE half of "the join target never becomes
 * a DOM attribute". The DOM half is pinned at the component level
 * (`_components/meeting-block.test.tsx`, `_components/agenda-list.test.tsx`), which is what
 * catches a behavioural regression; this half catches the same regression written a different
 * way — a `<Button asChild><a href={meeting.joinUrl}>` reintroduced anywhere on the route,
 * including on a surface no component test happens to render.
 *
 * Why an attribute is the hazard and a navigation is not: PostHog autocapture is ON and ships
 * `$elements[].attr__href`, which `sanitizeAnalyticsEvent` does not walk; Sentry
 * `replayIntegration` records rrweb DOM snapshots and its default `maskAttributes` excludes
 * `href`. Both processors would therefore see a raw meeting id the moment it is rendered — no
 * click required. As of BAL-566 fix round 1 (F1 / user ruling J1) the join target is
 * `memberCallPath`'s authenticated member call route, which is not on the
 * `SENSITIVE_PATH_PREFIXES` redaction list — it is already linked, unredacted, from in-app
 * notifications and absence emails — so this is not closing a dedicated redaction gap. It is
 * still worth keeping off the DOM: `globalThis.location.assign(joinUrl)` from a `<button>`
 * handler keeps it out entirely and avoids a Next prefetch firing the navigation on hover/
 * viewport, without depending on any Session Replay refusal (the call route is authenticated and
 * is not a landing `instrumentation-client.ts`'s `onSensitiveLanding` refuses).
 */
describe('invariant: no dashboard-adjacent surface renders a join URL/path as an href (BAL-498 S1, widened BAL-566 D9)', () => {
  const CALENDAR_DIR = resolveRouteDir([
    'src/app/(dashboard)/expert/calendar',
    'apps/web/src/app/(dashboard)/expert/calendar',
  ]);
  const DASHBOARD_DIR = resolveRouteDir([
    'src/app/(dashboard)/dashboard',
    'apps/web/src/app/(dashboard)/dashboard',
  ]);
  const COMPONENTS_DIR = resolveRouteDir([
    'src/components/balo/meetings',
    'apps/web/src/components/balo/meetings',
  ]);
  const BOOKING_DIR = resolveRouteDir([
    'src/components/booking',
    'apps/web/src/components/booking',
  ]);
  const CASES_DIR = resolveRouteDir([
    'src/app/(dashboard)/cases',
    'apps/web/src/app/(dashboard)/cases',
  ]);

  /**
   * BAL-566 — THREE trees, not one: the calendar route (BAL-498's original scope), the dashboard
   * route (the Up next card's row, BAL-566), and `components/balo/meetings` (where
   * `JoinMeetingButton` now lives, having moved out of the calendar route entirely). Each gets
   * its own prefix so a failure names which tree the offending file is in.
   *
   * ⚠ BAL-567 ADDS A FOURTH: `components/booking`. Both booking surfaces (`StepBooked` and
   * `StepBookedIntroCall`) render their action's `joinPath` as `sr-only` TEXT and never as an
   * `href`, so nothing was broken before — but before BAL-567 that prop held the ANONYMOUS lobby
   * path, which this scan is not really about. It now holds `memberCallPath`'s output, exactly
   * like the other three trees, which is what brings it into scope. Adding it now means a future
   * "let's make it a link" edit on either step fails here rather than shipping.
   *
   * ⚠ AND A FIFTH: the whole `(dashboard)/cases` tree. BAL-567 put a real Join on TWO surfaces
   * there — the `/cases` index's featured ticket card and the case page's in-window nudge — both
   * carrying `memberCallPath`'s output in a `joinPath` field. They are the newest place a
   * `<Button asChild><a href={…joinPath}>` could plausibly be written, which is precisely why
   * the tree is scanned rather than trusted.
   */
  const scanned = [
    ...scanRouteSources(CALENDAR_DIR, 'calendar', []),
    ...scanRouteSources(DASHBOARD_DIR, 'dashboard', []),
    ...scanRouteSources(COMPONENTS_DIR, 'components', []),
    ...scanRouteSources(BOOKING_DIR, 'booking', []),
    ...scanRouteSources(CASES_DIR, 'cases', []),
  ];

  /**
   * `href={ … joinUrl|joinPath … }` in any JSX-attribute shape. An indexOf walk, NOT a regex —
   * the same convention `_source-scan.ts` keeps for exactly this reason (SonarCloud S5852).
   *
   * ⚠ BOTH NAMES, DELIBERATELY. `joinUrl` is the calendar's prop name and `joinPath` is the
   * dashboard Up next row's (and both booking steps') prop name — as of BAL-566 fix round 1
   * (F1 / user ruling J1), and BAL-567 for the booking tree, ALL of them hold `memberCallPath`'s
   * output, the AUTHENTICATED member call route, never `meetingJoinLinkUrl`'s anonymous lobby URL
   * (BAL-567 deleted `memberJoinPath` outright). The call route is not on the
   * `SENSITIVE_PATH_PREFIXES` redaction list (it is already linked, unredacted, from in-app
   * notifications and absence emails), so the hazard here is narrower than the lobby URL's used
   * to be: it is not a NEW redaction gap, only an avoidable DOM exposure. Both prop names are
   * still checked because a future caller could reintroduce either shape.
   */
  function bindsJoinTargetToHref(code: string): boolean {
    const marker = 'href={';
    let index = code.indexOf(marker);
    while (index !== -1) {
      const close = code.indexOf('}', index + marker.length);
      const expression = close === -1 ? code.slice(index) : code.slice(index, close);
      if (
        expression.includes('joinUrl') ||
        expression.includes('joinPath') ||
        // BAL-566 fix round 2 (S) — a call site could skip the `row.joinPath`/`meeting.joinUrl`
        // prop entirely and build the target inline, e.g. `href={memberCallPath(row.meetingId)}`.
        // That is the SAME hazard by a different route into the expression, so the builder's own
        // name is caught too, not only the two prop names above.
        expression.includes('memberCallPath(')
      ) {
        return true;
      }
      index = code.indexOf(marker, index + marker.length);
    }
    return false;
  }

  it('collects all FIVE trees, including the two BAL-567 Join surfaces (guards against a vacuous pass)', () => {
    expect(CALENDAR_DIR).not.toBe('');
    expect(DASHBOARD_DIR).not.toBe('');
    expect(COMPONENTS_DIR).not.toBe('');
    expect(BOOKING_DIR).not.toBe('');
    expect(CASES_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    const rels = scanned.map((file) => file.rel);
    expect(rels).toContain('components/join-meeting-button.tsx');
    expect(rels).toContain('dashboard/_components/up-next-row.tsx');
    // BAL-567's two new Join surfaces, pinned BY NAME so a rename fails loudly here rather than
    // quietly dropping out of the scan.
    expect(rels).toContain('cases/_components/featured-case-card.tsx');
    expect(rels).toContain('cases/[engagementId]/_components/case-nudge.tsx');
  });

  it('⚠ guards the guard: a synthetic href={row.joinPath} is detected by the matcher', () => {
    expect(bindsJoinTargetToHref('<Link href={row.joinPath}>Join</Link>')).toBe(true);
    expect(bindsJoinTargetToHref('<Link href={meeting.joinUrl}>Join</Link>')).toBe(true);
    expect(bindsJoinTargetToHref('<Link href={row.href}>Open</Link>')).toBe(false);
  });

  it('⚠ guards the guard: a synthetic href={memberCallPath(row.meetingId)} is also detected', () => {
    expect(bindsJoinTargetToHref('<Link href={memberCallPath(row.meetingId)}>Join</Link>')).toBe(
      true
    );
    expect(bindsJoinTargetToHref('<Link href={memberCallPathLabel}>Open</Link>')).toBe(false);
  });

  it('no join URL or path is ever bound to an href — it is navigated to, never bound', () => {
    const offenders = scanned
      .filter((file) => bindsJoinTargetToHref(file.code))
      .map((file) => file.rel);

    expect(
      offenders,
      `These files bind a join URL/path to an href. The join target is memberCallPath's ` +
        `authenticated member call route — not on the SENSITIVE_PATH_PREFIXES redaction list, ` +
        `since it is already linked, unredacted, from in-app notifications and absence emails — ` +
        `so this is not closing a redaction gap, only an avoidable one: rendering it puts the ` +
        `meeting id into PostHog autocapture ($elements[].attr__href, which ` +
        `sanitizeAnalyticsEvent never walks) and Sentry Session Replay (rrweb DOM snapshots, ` +
        `href is not in maskAttributes) with no click required, and risks Next prefetching the ` +
        `route on hover/viewport. Use <JoinMeetingButton>, which navigates via ` +
        `globalThis.location.assign:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('the Join affordance still performs a HARD document navigation, not a soft one (reads the moved file)', () => {
    const joinButton = scanned.find((file) => file.rel === 'components/join-meeting-button.tsx');
    if (joinButton === undefined) throw new Error('join-meeting-button.tsx was not scanned');
    // A real navigation means Next never prefetches the member call route on hover/viewport, and
    // it keeps the target out of the DOM as an href. It does not gate a Session Replay refusal —
    // the call route is authenticated and `onSensitiveLanding` (instrumentation-client.ts) does
    // not match it; that mechanism only ever applied to the anonymous guest lobby this button no
    // longer targets.
    expect(joinButton.code).toContain('globalThis.location.assign');
    expect(joinButton.code).not.toContain('next/link');
    expect(joinButton.code).not.toContain('router.push');
  });
});
