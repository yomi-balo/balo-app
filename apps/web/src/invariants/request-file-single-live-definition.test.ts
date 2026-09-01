import { describe, expect, it } from 'vitest';
import { codeLinesOf, resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-431 / ADR-1048 §2+§5 (Ruling 2) — structural invariant: **THERE IS EXACTLY ONE DEFINITION
 * OF "THIS TRACK IS LIVE FOR FILES"**, and it lives at
 * `packages/shared/src/authz/request-files.ts` (`resolveRequestTrackFileAccess` /
 * `requestTrackIsLiveForFiles`). Everything in the request-files web tree consumes it; nothing
 * hand-rolls a second comparison against `'declined'` or `'not_selected'`.
 *
 * ⚠ WHY THIS MATTERS: a hand-rolled `status === 'declined'` check would silently drift from
 * `relationshipDeniesHosting` the moment the two representations (`status` / `declinedAt`)
 * disagree — the exact partial-write case the shared predicate fails CLOSED on. A hand-rolled
 * `notSelectedAt` check is not wrong on its face, but a SECOND site computing "closed" opens the
 * door to the two rules drifting on the EARLIEST-INSTANT reduction, which is what makes the
 * DELETE AUDIT SNAPSHOT (Ruling 4, append-only, no backfill) trustworthy.
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
  'lib/request-files/authorize-request-file-scope.ts',
  'lib/request-files/load-request-files.ts',
  'lib/request-files/request-file-audience-view.ts',
  'actions/request-shared-file-upload.ts',
  'actions/confirm-request-file-upload.ts',
  'actions/get-request-file-download.ts',
  'actions/revoke-request-file-grant.ts',
  'actions/delete-request-file.ts',
];

/**
 * ⚠ THE FORBIDDEN LITERALS. A file may FEED `declinedAt` / `status` INTO
 * `relationshipDeniesHosting` (which is imported, not re-implemented), but must never compare
 * either against the string `'declined'` or `'not_selected'` directly.
 */
const FORBIDDEN_LITERALS: readonly string[] = ["'declined'", "'not_selected'"];

/**
 * ⚠⚠ AN EXEMPTION, NOT A WEAKENING OF THE RULE — same posture as the meeting-call scan's
 * `CALL_LIB_FILES` allow-list. `load-request-files.ts`'s `closedReasonOf` produces a DISPLAY
 * LABEL (Ruling 2's client annotation copy: "declined" vs. "not selected") from a track ALREADY
 * PROVEN closed by `relationshipDeniesHosting` (imported, reused) plus a direct read of
 * `notSelectedAt !== null` (the stamped column, not a status string). It determines WHY, never
 * WHETHER, a track is closed — liveness itself is still resolved exclusively by
 * `resolveRequestTrackFileAccess`, which this same file also imports and calls (see the last
 * assertion below). Sweeping this literal-substring scan over it would flag the very copy
 * Ruling 2 requires.
 */
const REASON_LABEL_EXEMPT: ReadonlySet<string> = new Set([
  'lib/request-files/load-request-files.ts',
  // ⚠ `request-file-audience-view.ts`'s `ClientRequestFileAudienceAnnotation.reason` is a
  // STRUCTURAL TYPE FIELD (`'declined' | 'not_selected'`) whose only producer is
  // `load-request-files.ts`'s `closedReasonOf` (exempted above). This serializer SWITCHES on
  // an already-derived value to shape copy — it never reads a raw `status`/`declinedAt`/
  // `notSelectedAt` column and cannot re-derive liveness.
  'lib/request-files/request-file-audience-view.ts',
  // ⚠ `request-file-audience-badges.tsx` renders `annotation.reason` — the SAME already-derived
  // field, one hop further downstream (component props, not a repository/DB read). Same
  // reasoning as the serializer above.
  'components/request-file-audience-badges.tsx',
  // ⚠ `expert-closure-banner.tsx` is the EXPERT-lens mirror of that badge copy (Ruling 2): it
  // keys a two-entry copy lookup off `RequestTrackClosedReason`, the same already-derived
  // display label `closedReasonOf` produces. It reads no column and cannot re-derive liveness —
  // `request-files-panel.tsx`, which decides WHETHER to render it, does so on a bare
  // `closedReason !== null` and is therefore NOT exempt and still fully scanned.
  'components/expert-closure-banner.tsx',
]);

describe('invariant: request files never hand-roll a second live-track definition (BAL-431)', () => {
  const scanned = scanTree();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects the trees (guards against a vacuous pass)', () => {
    expect(LIB_DIR).not.toBe('');
    expect(COMPONENTS_DIR).not.toBe('');
    expect(ACTIONS_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
  });

  it('⚠ guards the guard: the codeLinesOf filter strips only comments', () => {
    const stripped = codeLinesOf("// 'declined' is mentioned only in this comment\nconst a = 1;");
    expect(stripped).not.toContain("'declined'");
    expect(stripped).toContain('const a = 1;');
  });

  it('⚠⚠ no file in the request-files tree hand-rolls a `declined` / `not_selected` comparison', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      if (REASON_LABEL_EXEMPT.has(file.rel)) continue;
      for (const literal of FORBIDDEN_LITERALS) {
        if (file.code.includes(literal)) offenders.push(`${file.rel} → ${literal}`);
      }
    }
    expect(
      offenders,
      `These request-files sources compare a status/reason literal directly instead of going ` +
        `through resolveRequestTrackFileAccess / requestTrackIsLiveForFiles ` +
        `(@balo/shared/authz/request-files). There must be exactly ONE definition of "this ` +
        `track is closed, and when":\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('the gate + loader import the shared predicate rather than re-deriving it', () => {
    const gate = scanned.find(
      (file) => file.rel === 'lib/request-files/authorize-request-file-scope.ts'
    );
    expect(gate).toBeDefined();
    expect(gate?.code ?? '').toContain('resolveRequestTrackFileAccess');

    // ⚠ THE EXEMPTION'S OWN PROOF: `load-request-files.ts` is excused from the literal scan
    // above only because it still resolves liveness through the shared predicate.
    const loader = scanned.find((file) => file.rel === 'lib/request-files/load-request-files.ts');
    expect(loader).toBeDefined();
    expect(loader?.code ?? '').toContain('resolveRequestTrackFileAccess');
    expect(loader?.code ?? '').toContain('relationshipDeniesHosting');
  });
});
