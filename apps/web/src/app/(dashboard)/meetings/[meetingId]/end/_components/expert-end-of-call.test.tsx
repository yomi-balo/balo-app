import { describe, it, expect } from 'vitest';
import { codeLinesOf, resolveRouteDir, scanRouteSources } from '@/invariants/_source-scan';

/**
 * BAL-389 — THE STRUCTURAL PROOF OF THE ACCEPTANCE CRITERION that the expert lens shows no
 * rating and no resolve action.
 *
 * ⚠⚠ THIS IS A SOURCE SCAN, NOT A RENDER TEST, AND THAT IS THE POINT. A render test asserts
 * "the prompt did not appear for THIS fixture"; it cannot rule out a future `lens === 'expert'`
 * conditional that leaks on some other fixture. Reading the composition source proves the expert
 * arm has NO PATH to the rating block or the resolve prompt, because nothing it reaches ever
 * names them.
 *
 * ⚠⚠ THE SCAN COVERS **EVERY** FILE UNDER `end/_components/`, NOT JUST THE TWO COMPOSITIONS.
 * `expert-end-of-call.tsx` is a delegation: the card body lives in `end-of-call-layout.tsx`,
 * which a two-file scan would never open. Adding `import { RateThenResolve }` plus a
 * `{view.lens === 'client' && …}` to the LAYOUT would leak the island to the expert lens with
 * every other assertion still green. The allow-list is the point: the four modules that may
 * legitimately name the island are the client composition and the three client-only components
 * that ARE it.
 *
 * ⚠ THE READ USES A CWD-CANDIDATE LIST. CI runs web vitest from the REPO ROOT while a developer
 * runs it from `apps/web`; a single cwd-relative path resolves to nothing in one of the two, and
 * a scan that finds nothing passes every assertion for the wrong reason (memory
 * `reference_web_server_disk_asset_cwd`). The guards-the-guard tests below turn that into a loud
 * failure instead.
 *
 * ⚠ THE HELPERS ARE IMPORTED FROM `@/invariants/_source-scan`, NEVER RE-IMPLEMENTED — that
 * module exists precisely because a second verbatim copy of the scan is the duplication shape
 * SonarCloud's >3% new-code gate catches.
 */
const ROUTE = 'app/(dashboard)/meetings/[meetingId]/end/_components';

const COMPONENTS_DIR = resolveRouteDir(['src/' + ROUTE, 'apps/web/src/' + ROUTE]);
const FILES = scanRouteSources(COMPONENTS_DIR, '', []);

/** Every name that means "the rating" or "the resolve prompt", in source or in a specifier. */
const FORBIDDEN_NAMES = [
  'RateThenResolve',
  'rate-then-resolve',
  'RatingBlock',
  'rating-block',
  'ResolvePrompt',
  'resolve-prompt',
  'ResolveDialog',
  'resolve-dialog',
  'submitEngagementReviewAction',
  'submit-engagement-review',
  'resolveCaseAction',
  'resolve-case',
] as const;

/**
 * The ONLY modules allowed to name them: the client composition, and the three client-only
 * components that ARE the island. Everything else — the layout, the onward CTA, and both
 * expert-side files — must be incapable of mounting it.
 */
const ALLOWED = new Set([
  'client-end-of-call.tsx',
  'rate-then-resolve.tsx',
  'rating-block.tsx',
  'resolve-prompt.tsx',
]);

/**
 * The recap's DISMISSAL model, by name. The end screen's ticket is explicit that ignoring or
 * declining does nothing — no penalty, no persistence, no re-prompt — so none of these may
 * appear in ANY file under this route, allow-listed or not.
 */
const DISMISSAL_NAMES = [
  'ResolveDismissalProvider',
  'UnlessDismissed',
  'resolve-dismissal',
  'dismissResolutionRequestAction',
  'dismiss-resolution-request',
] as const;

function fileNamed(rel: string): string {
  return FILES.find((file) => file.rel === rel)?.code ?? '';
}

describe('expert-end-of-call — the rating and the resolve prompt are STRUCTURALLY unreachable', () => {
  it('guards the guard — the directory was actually found and walked', () => {
    expect(COMPONENTS_DIR).not.toBe('');
    // A scan that silently found nothing would pass every negative assertion below.
    expect(FILES.length).toBeGreaterThanOrEqual(6);
    for (const rel of ALLOWED) {
      expect(FILES.map((file) => file.rel)).toContain(rel);
    }
    expect(FILES.map((file) => file.rel)).toContain('expert-end-of-call.tsx');
    expect(FILES.map((file) => file.rel)).toContain('end-of-call-layout.tsx');
  });

  it('guards the guard — the CLIENT composition genuinely names the island', () => {
    // If this ever goes red, the names changed and every negative assertion below has quietly
    // become vacuous.
    expect(fileNamed('client-end-of-call.tsx')).toContain('RateThenResolve');
    const island = fileNamed('rate-then-resolve.tsx');
    expect(island).toContain('RatingBlock');
    expect(island).toContain('ResolvePrompt');
  });

  it('names the rating or the resolve prompt in NO file except the four that are it', () => {
    for (const file of FILES) {
      if (ALLOWED.has(file.rel)) continue;
      for (const name of FORBIDDEN_NAMES) {
        expect(file.code.includes(name), file.rel + ' must not reference ' + name).toBe(false);
      }
    }
  });

  it('contains no lens conditional anywhere in the shared shell or the expert arm', () => {
    // The branch is at COMPOSITION. A `lens === 'expert'` test in the layout or the expert file
    // would mean the copy is being HIDDEN rather than never mounted — exactly the failure mode
    // the union-typed view exists to make impossible.
    for (const rel of ['expert-end-of-call.tsx', 'end-of-call-layout.tsx']) {
      const code = fileNamed(rel);
      expect(code).not.toBe('');
      expect(code).not.toContain('lens === ');
      expect(code).not.toContain('view.resolve');
      expect(code).not.toContain('view.rating');
    }
  });

  it('keeps the expert composition a pure delegation with no post-call slot', () => {
    const expertCode = codeLinesOf(fileNamed('expert-end-of-call.tsx'));
    expect(expertCode).not.toBe('');
    expect(expertCode).toContain('EndOfCallLayout');
    expect(expertCode).not.toContain('view.resolve');
    expect(expertCode).not.toContain('view.rating');
    expect(expertCode).not.toContain('postCallActions');
  });

  it("imports NONE of the recap's dismissal machinery, anywhere in the route", () => {
    // ⚠ The recap's R4/R9 mutual-exclusion + dismissal model implements "do not ask twice in one
    // session" by WRITING to the DB. This screen's answer to "Not yet" is that nothing happens
    // at all, so importing any of this would be a behaviour the ticket rules out.
    for (const file of FILES) {
      for (const name of DISMISSAL_NAMES) {
        expect(file.code.includes(name), file.rel + ' must not reference ' + name).toBe(false);
      }
    }
  });

  it('compares no rating against a literal threshold, anywhere under the route', () => {
    // ⚠ The `< 4` boundary is decided ONCE, by `resolveEndOfCallReviewState` with its DEFAULT
    // `LOW_RATING_THRESHOLD`. A component that re-derived it would be a second definition of the
    // rule BAL-390 built to have exactly one.
    for (const file of FILES) {
      expect(file.code, file.rel + ' must not import the threshold').not.toContain(
        'LOW_RATING_THRESHOLD'
      );
      for (const shape of ['< 4', '<4', '>= 4', '>=4', '< LOW', '>= LOW']) {
        expect(
          file.code.includes(shape),
          file.rel + ' must not re-derive the rating boundary (' + shape + ')'
        ).toBe(false);
      }
    }
  });

  it('reaches for NO Rejoin destination — the owner decision, pinned by name', () => {
    // `/join/m/{id}` is the ANONYMOUS lobby (the wrong arm for a signed-in member) and
    // `joinAsMemberAction` has no entry point by design. BAL-435 adds the button, the
    // destination and the `'rejoin'` analytics value together.
    for (const file of FILES) {
      expect(file.code.includes('/join/m/'), file.rel + ' must not link to the guest lobby').toBe(
        false
      );
      expect(file.code).not.toContain('joinAsMemberAction');
      expect(file.code).not.toContain("'rejoin'");
    }
  });
});
