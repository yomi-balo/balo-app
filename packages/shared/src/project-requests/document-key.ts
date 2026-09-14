/**
 * project-requests/document-key (BAL-254) — THE draft-stage project-document R2 key boundary.
 *
 * ⚠⚠ THE ONLY PLACE THIS BOUNDARY IS DEFINED (Ruling A).
 *
 * A draft's uploads have NO DB ROW until submit (`confirm-project-document-upload.ts`'s comment)
 * and BAL-431's audience/grant model DELIBERATELY EXCLUDES them (`schema/request-files.ts`), so
 * there is nothing to "read through": this prefix check IS the entire authorization boundary.
 * The ids MUST come from the SESSION (web) or from the PERSISTED ROW (the worker), never from
 * client input.
 *
 * ── WHY IT LIVES IN `@balo/shared` (BAL-254 W9) ────────────────────────────────────────
 * It shipped in `apps/web/src/lib/storage/`, with two web callers and its own docblock warning
 * that "a third definition is a cross-tenant R2 read waiting to happen". The worker's Gate 3
 * then became exactly that third definition — a hand-rolled
 * `\`project-documents/${companyId}/${userId}/\`` + `startsWith`, with NO SHAPE CHECK, in
 * `apps/api/src/services/project-brief/parse.ts`. `apps/api` cannot import from `apps/web`, so
 * the only way to have one definition is for it to live here. `apps/web`'s invariant
 * `project-brief-boundaries-single-caller.test.ts` walks `packages/` and `apps/api/src` too, so
 * moving it here also brings the API side under that pin for the first time.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER
 * (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. No I/O, no clock, no `server-only` — so it unit-tests without a Next runtime and is safe
 * for a Fastify worker.
 */

/**
 * `project-documents/{companyId uuid}/{userId uuid}/{uuid}`.
 *
 * ⚠ THE SHAPE CHECK IS HALF THE GUARD. A bare `startsWith` on the owner prefix accepts anything
 * appended after it — `…/{userId}/../../secret` included. Bounded quantifiers only, no nesting
 * and no alternation (SonarCloud S5852).
 */
export const PROJECT_DOCUMENT_KEY_PATTERN =
  /^project-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/** The owning company + user a key must be scoped to. */
export interface ProjectDocumentKeyOwner {
  readonly companyId: string;
  readonly userId: string;
}

/**
 * True when `key` is a well-formed project-document key scoped to exactly this owner.
 *
 * Callers (pinned by `apps/web/src/invariants/project-brief-boundaries-single-caller.test.ts`):
 *  1. `confirmProjectDocumentUploadAction` — owner ids from the SESSION.
 *  2. `startProjectBriefParseAction` — owner ids from the SESSION.
 *  3. `apps/api`'s `runProjectBriefParse` (Gate 3) — owner ids from the PERSISTED ROW, because a
 *     BullMQ processor has no session and the job payload is `{ parseId }` alone.
 *
 * A fourth caller means someone re-derived the prefix; make sure its ids come from one of those
 * two trusted places and add it to the pin deliberately.
 */
export function isSessionOwnedProjectDocumentKey(
  key: string,
  owner: ProjectDocumentKeyOwner
): boolean {
  if (!PROJECT_DOCUMENT_KEY_PATTERN.test(key)) return false;
  const expectedPrefix = `project-documents/${owner.companyId}/${owner.userId}/`;
  return key.startsWith(expectedPrefix);
}
