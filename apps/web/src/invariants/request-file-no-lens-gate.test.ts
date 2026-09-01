import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-431 / ADR-1029 — structural invariant: **NO CONSUMER OF THE REQUEST-FILE SCOPE GATE
 * RE-IMPLEMENTS AUTHORIZATION ON A VIEW-SHAPED TOKEN.** `lens` gates a VIEW; a capability gates
 * a MUTATION (`hasCapability` / `hasPlatformCapability`). Every one of the five actions and
 * every UI component in this feature must reach `authorizeRequestFileScope`'s resolved `side`
 * (already capability-checked) rather than re-deriving a decision from `lens`, `role`,
 * `platformRole` or `activeMode`.
 *
 * ⚠⚠ `authorize-request-file-scope.ts` IS DELIBERATELY EXCLUDED FROM THIS SCAN — it is THE
 * RESOLVER ITSELF, and reading `ctx.lens` there to ROUTE to the correct capability check
 * (`hasCapability(..., PARTICIPATE, ...)` for the client arm, `hasPlatformCapability(...,
 * VIEW_ANY_REQUEST_FILE)` for the admin arm) is the same shape the shipped
 * `resolve-conversation-access.ts`'s `authorizeThread` already uses (`ctx.lens === 'expert'`).
 * The rule this test polices is "no SECOND, hand-rolled gate downstream of the resolver" — not
 * "the resolver may not read the lens it was handed". Banning the token inside the resolver
 * itself would assert a rule the codebase's own shipped pattern already contradicts.
 *
 * ⚠⚠ `request-files-panel.tsx` AND `request-file-row.tsx` ARE ALSO EXEMPT, for the SAME
 * reasoning the meeting-call invariant already established for `DrawdownState.lens`
 * (`meeting-call-no-lens-gate.test.ts`): `RequestFilesView['lens']` / `RequestFileRowProps['lens']`
 * are NOT `ctx.lens` re-read in the browser — they are the LOADER's own view-shape discriminant
 * (`request-file-audience-view.ts`'s `RequestFileAudienceLens`), assigned from the GATE's
 * already-capability-checked `scope.side` inside `loadRequestFiles` (server-side, before any
 * props cross to the client). Branching a component's RENDER on it is PRESENTATIONAL COPY
 * SELECTION between three shapes the server already decided the viewer may see — never a
 * second authorization decision. No mutation in either file reads this field: every
 * `canDelete` / `canRevoke` affordance is a boolean the server already computed into the view
 * object. **Avoid the token generally, exempt the file when it is proven safe — never widen the
 * ban to swallow a legitimate, already-verified label.**
 */

const LIB_DIR = resolveRouteDir(['src/lib/request-files', 'apps/web/src/lib/request-files']);
const COMPONENTS_DIR = resolveRouteDir([
  'src/components/balo/project-request/files',
  'apps/web/src/components/balo/project-request/files',
]);
const ACTIONS_DIR = resolveRouteDir([
  'src/app/(dashboard)/projects/[requestId]/_actions',
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions',
]);

const REQUEST_FILE_ACTION_FILES: ReadonlySet<string> = new Set([
  'request-shared-file-upload.ts',
  'confirm-request-file-upload.ts',
  'get-request-file-download.ts',
  'revoke-request-file-grant.ts',
  'delete-request-file.ts',
]);

/** The ONE file allowed to route on `lens` — see the module docblock. */
const RESOLVER_FILE = 'lib/request-files/authorize-request-file-scope.ts';

/**
 * The view-shape dispatch layer — presentational copy selection over an already
 * capability-checked label, never a second authorization decision. See the module docblock.
 */
const VIEW_DISPATCH_EXEMPT: ReadonlySet<string> = new Set([
  'components/request-files-panel.tsx',
  'components/request-file-row.tsx',
]);

function scanTree(): ScannedFile[] {
  return [
    ...scanRouteSources(LIB_DIR, 'lib/request-files', []),
    ...scanRouteSources(COMPONENTS_DIR, 'components', []),
    ...scanRouteSources(ACTIONS_DIR, 'actions', []).filter((file) =>
      REQUEST_FILE_ACTION_FILES.has(file.rel.slice('actions/'.length))
    ),
  ];
}

const PINNED_FILES: readonly string[] = [
  RESOLVER_FILE,
  'lib/request-files/load-request-files.ts',
  'lib/request-files/request-file-audience-view.ts',
  'actions/request-shared-file-upload.ts',
  'actions/confirm-request-file-upload.ts',
  'actions/get-request-file-download.ts',
  'actions/revoke-request-file-grant.ts',
  'actions/delete-request-file.ts',
];

const VIEW_GATE_TOKENS: readonly string[] = [
  'lens ===',
  "lens === '",
  'role ===',
  "role === '",
  'platformRole ===',
  'activeMode ===',
];

describe('invariant: request-file consumers never gate on lens/role/platformRole/activeMode (BAL-431 / ADR-1029)', () => {
  const scanned = scanTree().filter((file) => file.rel !== RESOLVER_FILE);
  const scannedPaths = scanTree().map((file) => file.rel);

  it('collects the trees (guards against a vacuous pass)', () => {
    expect(LIB_DIR).not.toBe('');
    expect(COMPONENTS_DIR).not.toBe('');
    expect(ACTIONS_DIR).not.toBe('');
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
  });

  it('⚠ guards the guard: the resolver itself DOES route on lens (proving the exclusion is real, not a typo)', () => {
    const resolver = scanTree().find((file) => file.rel === RESOLVER_FILE);
    expect(resolver).toBeDefined();
    expect(resolver?.code ?? '').toContain("lens === 'client'");
  });

  it('⚠ guards the guard: the view-dispatch exemption is real, not a typo', () => {
    for (const rel of VIEW_DISPATCH_EXEMPT) {
      const file = scanTree().find((f) => f.rel === rel);
      expect(file, `${rel} is not in the scan — the exemption would be vacuous`).toBeDefined();
      expect(file?.code ?? '').toContain('lens ===');
    }
  });

  it('⚠⚠ no OTHER request-file source gates on a lens, role, platformRole or activeMode comparison', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      if (VIEW_DISPATCH_EXEMPT.has(file.rel)) continue;
      for (const token of VIEW_GATE_TOKENS) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These request-file sources reference a VIEW-shaped authorization token OUTSIDE the ` +
        `resolver. Every action/component must reach authorizeRequestFileScope's resolved ` +
        `\`side\` (already capability-checked) rather than re-deriving a decision from lens, ` +
        `role, platformRole or activeMode:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('every action authorizes through authorizeRequestFileScope, never a bare requireAdmin-style role check', () => {
    const actionFiles = scanned.filter((file) => file.rel.startsWith('actions/'));
    for (const file of actionFiles) {
      expect(
        file.code,
        `${file.rel} must import authorizeRequestFileScope — it is the ONE gate for this feature.`
      ).toContain('authorizeRequestFileScope');
    }
  });
});
