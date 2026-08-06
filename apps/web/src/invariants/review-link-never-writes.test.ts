import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BAL-390 §8.7.1 — structural invariant for **THE STAR LINK PREFILLS, IT NEVER WRITES.**
 *
 * The `/review/{token}` landing page is reached by clicking a star in an email, so its
 * URL is handled by machines long before a human sees it: Gmail's link proxy, Microsoft
 * Defender Safe Links detonation, Proofpoint/Barracuda rewriting and MDM prefetch all
 * issue unsolicited GETs. A GET that wrote would submit ratings nobody chose, silently,
 * at marketplace scale, and corrupt the expert aggregate irreversibly — there is no
 * "undo the rating the scanner left" path.
 *
 * The only write is a Next Server Action (`submitTokenReviewAction`), which is POST-only
 * by construction: it needs the `Next-Action` header and a build-time action id, so it
 * cannot be reached by navigation, prefetch, an `<img>` or a rewritten scanner URL.
 *
 * TWO tests guard this, deliberately, because each survives the other's failure mode:
 *   - `app/review/[token]/page.test.tsx` fires 20 GETs with `?r=5` and asserts
 *     `reviewsRepository.upsert` was called ZERO times. That survives indirection (a
 *     write hidden behind a helper still shows up) but dies the moment someone swaps the
 *     `@balo/db` mock.
 *   - THIS test reads the source and asserts the write is not even referenced. That
 *     survives any mock change but can be dodged by indirection.
 * Neither is redundant; both are cheap.
 *
 * ⚠ SCOPE. `_actions/` is excluded — `submit-token-review.ts` and `review-write-shared.ts`
 * are the POST path and legitimately call `upsert`. Everything else under
 * `apps/web/src/app/review/` is GET-path or render-path code and must stay read-only
 * with respect to the `reviews` table.
 *
 * ⚠ `reviewInviteTokensRepository.recordAccess` IS a write, IS on the GET path, and is
 * CORRECT — this invariant is not "the page writes nothing", it is "the page never
 * writes a REVIEW". Stating it that narrowly is what keeps it true and enforceable.
 *
 * If this test fails: you added a review write to the GET path. Move it into the Server
 * Action in `app/review/_actions/`.
 */

/**
 * CI runs web vitest from the REPO ROOT (`pnpm test:coverage`) while a developer runs it
 * from `apps/web`, so a single cwd-relative path resolves to nothing in one of the two —
 * and a walk that finds nothing passes every assertion below for the wrong reason. A
 * candidate list covers both (`reference_web_server_disk_asset_cwd`), and the empty
 * fallback is caught loudly by the non-vacuity test rather than silently.
 *
 * (`import.meta.url` is NOT usable here: under vitest's jsdom environment it is an
 * `http://` URL, so `fileURLToPath` throws "The URL must be of scheme file".)
 */
const REVIEW_DIR =
  ['src/app/review', 'apps/web/src/app/review']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate)) ?? '';

/**
 * The GET/render path, pinned. Relative to `app/review`, POSIX separators. Pinning is the
 * non-vacuity guard: a directory walk that silently finds nothing passes everything.
 */
const PINNED_GET_PATH_FILES: readonly string[] = [
  'layout.tsx',
  '[token]/page.tsx',
  '[token]/loading.tsx',
  '[token]/error.tsx',
  '[token]/link-not-active.tsx',
  '[token]/_components/review-form.tsx',
];

/**
 * The ONLY `reviewsRepository` members the GET path may reach. Both are reads. This is an
 * ALLOW-list rather than a deny-list of `upsert` alone, so a future write member added
 * under any name (`recordRating`, `saveDraft`, …) fails here instead of shipping.
 */
const ALLOWED_REVIEWS_REPOSITORY_MEMBERS: readonly string[] = ['findLandingContext', 'findLive'];

/**
 * Drop whole comment lines. Line-oriented, so there is no regex anywhere (the SonarCloud
 * S5852 ReDoS gate) and no character-level state machine to get wrong.
 *
 * Comments MUST NOT count: `page.tsx`'s docblock NAMES `reviewsRepository.upsert` while
 * explaining that it is never called, and that explanation must not trip the invariant it
 * documents. A TRAILING `// …` after real code is deliberately kept — the failure mode is
 * then a false ALARM (someone writes a forbidden name in an end-of-line comment and this
 * test complains), never a false pass, which is the correct direction for a security
 * invariant to be wrong in.
 */
function codeLinesOf(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      inBlock = !line.includes('*/');
      continue;
    }
    if (line.startsWith('/*')) {
      inBlock = !line.includes('*/');
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    kept.push(raw);
  }
  return kept.join('\n');
}

/**
 * Every `<object>.<member>` name used on `object`, in source order. indexOf scan, never a
 * regex. A marker with no parseable member yields `<unparsed>` so a malformed reference
 * FAILS the allow-list loudly rather than vanishing from the results.
 */
function memberNamesOf(source: string, object: string): string[] {
  const names: string[] = [];
  const marker = `${object}.`;
  let i = source.indexOf(marker);
  while (i !== -1) {
    let end = i + marker.length;
    while (end < source.length) {
      const ch = source.charAt(end);
      const word =
        (ch >= 'a' && ch <= 'z') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_';
      if (!word) break;
      end += 1;
    }
    const name = source.slice(i + marker.length, end);
    names.push(name.length === 0 ? '<unparsed>' : name);
    i = source.indexOf(marker, i + marker.length);
  }
  return names;
}

interface ScannedFile {
  readonly rel: string;
  readonly code: string;
}

/** Every non-test source file under `app/review`, minus the `_actions` POST path. */
function scanGetPath(dir: string, prefix: string): ScannedFile[] {
  const found: ScannedFile[] = [];
  if (dir === '' || !existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // The POST path. `submit-token-review.ts` / `review-write-shared.ts` legitimately
      // write; scanning them would make this invariant impossible to satisfy.
      if (entry.name !== '_actions') found.push(...scanGetPath(`${dir}/${entry.name}`, rel));
      continue;
    }
    const isSource = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
    if (!isSource || entry.name.includes('.test.')) continue;
    found.push({ rel, code: codeLinesOf(readFileSync(`${dir}/${entry.name}`, 'utf8')) });
  }
  return found;
}

describe('invariant: the /review/{token} GET path never writes a review (BAL-390 §8.7.1)', () => {
  const scanned = scanGetPath(REVIEW_DIR, '');
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects the pinned GET-path files (guards against a vacuous pass)', () => {
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_GET_PATH_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
  });

  it('excludes the _actions POST path from the scan (it is allowed to write)', () => {
    expect(scannedPaths.filter((rel) => rel.includes('_actions'))).toEqual([]);
  });

  it('guards the guard: the matcher can see a reviewsRepository call that IS present', () => {
    // If `memberNamesOf` or `codeLinesOf` ever breaks, every assertion below passes
    // vacuously. `page.tsx` legitimately calls two READ members — prove the very matcher
    // the assertions use finds them.
    const page = scanned.find((file) => file.rel === '[token]/page.tsx');
    expect(page).toBeDefined();
    const members = memberNamesOf(page?.code ?? '', 'reviewsRepository');
    expect(members).toContain('findLandingContext');
    expect(members).toContain('findLive');
  });

  it('no GET-path file references reviewsRepository.upsert', () => {
    const offenders = scanned
      .filter((file) => file.code.includes('reviewsRepository.upsert'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These files are on the /review/{token} GET path but reference reviewsRepository.upsert. ` +
        `An emailed URL is fetched by link scanners and prefetchers, so a GET that writes ` +
        `submits ratings nobody chose. Move the write into app/review/_actions/:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('the GET path uses ONLY read members of reviewsRepository (allow-list, rename-proof)', () => {
    const used = new Set<string>();
    for (const file of scanned) {
      for (const member of memberNamesOf(file.code, 'reviewsRepository')) {
        used.add(member);
      }
    }
    const disallowed = [...used]
      .filter((member) => !ALLOWED_REVIEWS_REPOSITORY_MEMBERS.includes(member))
      .sort();
    expect(
      disallowed,
      `The /review/{token} GET path may only READ from reviewsRepository (allowed: ` +
        `${ALLOWED_REVIEWS_REPOSITORY_MEMBERS.join(', ')}). It now also uses: ` +
        `${disallowed.join(', ')}. If that member is a WRITE it belongs in the Server ` +
        `Action; if it is genuinely a read, add it to ALLOWED_REVIEWS_REPOSITORY_MEMBERS ` +
        `with a one-line justification.`
    ).toEqual([]);
  });

  it('no GET-path file imports the shared write path (applyReview)', () => {
    // The indirection escape: `page.tsx` importing `applyReview` from `_actions/` would
    // defeat every name-keyed check above while writing exactly the same row.
    expect(scanned.filter((file) => file.code.includes('applyReview')).map((f) => f.rel)).toEqual(
      []
    );
  });
});
