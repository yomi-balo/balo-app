import { describe, it, expect } from 'vitest';
import { codeLinesOf, resolveRouteDir, scanRouteSources } from '@/invariants/_source-scan';

/**
 * BAL-388 — THE STRUCTURAL PROOF OF THE ACCEPTANCE CRITERION that the expert lens never shows
 * the resolve prompt.
 *
 * ⚠⚠ THIS IS A SOURCE SCAN, NOT A RENDER TEST, AND THAT IS THE POINT. A render test asserts
 * "the banner did not appear for THIS fixture"; it cannot rule out a future `lens === expert`
 * conditional that leaks on some other fixture. Reading the composition source proves the
 * expert arm has no PATH to R4 or R9 at all, because nothing it reaches ever names them.
 *
 * ⚠⚠ THE SCAN COVERS **EVERY** FILE UNDER `_components/`, NOT JUST THE TWO COMPOSITIONS, AND
 * THE SCOPE IS THE WHOLE INVARIANT. `expert-recap.tsx` is a ONE-LINE delegation: the entire page
 * body lives in `recap-layout.tsx`, which a two-file scan never opened. Adding
 * `import { ResolvePromptBanner }` plus `{view.lens === 'client' && ...}` to the LAYOUT would have
 * leaked the prompt to the expert lens with every assertion still green. The allow-list below
 * is the point: the four modules that may legitimately name the prompt are the client
 * composition and the three client-only components themselves.
 *
 * ⚠ THE READ USES A CWD-CANDIDATE LIST. CI runs web vitest from the REPO ROOT while a
 * developer runs it from `apps/web`; a single cwd-relative path resolves to nothing in one of
 * the two, and a scan that finds nothing passes every assertion for the wrong reason (memory
 * `reference_web_server_disk_asset_cwd`). The guards-the-guard tests below turn that into a
 * loud failure instead.
 */
const ROUTE = 'app/(dashboard)/meetings/[meetingId]/_components';

const COMPONENTS_DIR = resolveRouteDir(['src/' + ROUTE, 'apps/web/src/' + ROUTE]);
const FILES = scanRouteSources(COMPONENTS_DIR, '', []);

/** Every name that means "the resolve prompt", in source or in an import specifier. */
const RESOLVE_PROMPT_NAMES = [
  'ResolvePromptBanner',
  'resolve-prompt-banner',
  'WrapUpCard',
  'wrap-up-card',
  'ResolveDialog',
  'resolve-dialog',
] as const;

/**
 * The ONLY modules allowed to name the prompt: the client composition, and the three
 * client-only components that ARE the prompt. Everything else — the layout, the header, the
 * party card, the files card, the transcript, the not-held panel, and both expert-side files —
 * must be incapable of mounting it.
 */
const ALLOWED = new Set([
  'client-recap.tsx',
  'resolve-prompt-banner.tsx',
  'wrap-up-card.tsx',
  'resolve-dialog.tsx',
]);

function fileNamed(rel: string): string {
  return FILES.find((file) => file.rel === rel)?.code ?? '';
}

describe('expert-recap — the resolve prompt is STRUCTURALLY unreachable', () => {
  it('guards the guard — the directory was actually found and walked', () => {
    expect(COMPONENTS_DIR).not.toBe('');
    // A scan that silently found nothing would pass every negative assertion below.
    expect(FILES.length).toBeGreaterThanOrEqual(10);
    for (const rel of ALLOWED) {
      expect(FILES.map((file) => file.rel)).toContain(rel);
    }
    expect(FILES.map((file) => file.rel)).toContain('expert-recap.tsx');
    expect(FILES.map((file) => file.rel)).toContain('recap-layout.tsx');
  });

  it('guards the guard — the CLIENT composition genuinely names both prompts', () => {
    // If this ever goes red, the names changed and every negative assertion below has quietly
    // become vacuous.
    const clientCode = fileNamed('client-recap.tsx');
    expect(clientCode).toContain('ResolvePromptBanner');
    expect(clientCode).toContain('WrapUpCard');
  });

  it('names the resolve prompt in NO file under _components/ except the four that are it', () => {
    for (const file of FILES) {
      if (ALLOWED.has(file.rel)) continue;
      for (const name of RESOLVE_PROMPT_NAMES) {
        expect(file.code.includes(name), file.rel + ' must not reference ' + name).toBe(false);
      }
    }
  });

  it('contains no lens conditional anywhere in the shared shell or the expert arm', () => {
    // The branch is at COMPOSITION. A `lens === expert` test in the layout or the expert file
    // would mean the copy is being HIDDEN rather than never mounted, which is exactly the
    // failure mode the union-typed view exists to make impossible. `client-recap.tsx` is
    // allowed to read `resolve.variant` — it is the client arm, and both slots are its own.
    for (const rel of ['expert-recap.tsx', 'recap-layout.tsx']) {
      const code = fileNamed(rel);
      expect(code).not.toContain('lens === ');
      expect(code).not.toContain('resolve.variant');
      expect(code).not.toContain('view.resolve');
    }
  });

  it('keeps the expert composition a pure delegation', () => {
    const expertCode = fileNamed('expert-recap.tsx');
    expect(expertCode).not.toBe('');
    expect(expertCode).toContain('RecapLayout');
    expect(codeLinesOf(expertCode)).not.toContain('view.resolve');
  });
});
