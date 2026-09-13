/** `project-documents/{companyId uuid}/{userId uuid}/{uuid}` */
export const PROJECT_DOCUMENT_KEY_PATTERN =
  /^project-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/**
 * ⚠⚠ THE ONLY PLACE THE DRAFT-STAGE DOCUMENT BOUNDARY IS DEFINED (BAL-254 Ruling A).
 *
 * A draft's uploads have NO DB ROW until submit (`confirm-project-document-upload.ts`'s comment)
 * and BAL-431's audience/grant model DELIBERATELY EXCLUDES them (`schema/request-files.ts`), so
 * there is nothing to "read through": this prefix check IS the entire authorization boundary.
 * The ids MUST come from the SESSION, never from client input.
 *
 * Two callers: `confirmProjectDocumentUploadAction` (which previously inlined this) and
 * `startProjectBriefParseAction`. A third definition is a cross-tenant R2 read waiting to
 * happen.
 *
 * No `server-only` — pure string logic, so it unit-tests without a Next runtime.
 */
export function isSessionOwnedProjectDocumentKey(
  key: string,
  owner: { companyId: string; userId: string }
): boolean {
  if (!PROJECT_DOCUMENT_KEY_PATTERN.test(key)) return false;
  const expectedPrefix = `project-documents/${owner.companyId}/${owner.userId}/`;
  return key.startsWith(expectedPrefix);
}
