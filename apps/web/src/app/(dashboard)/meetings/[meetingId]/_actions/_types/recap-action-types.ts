/**
 * BAL-388 — result shapes for the two recap Server Actions. PLAIN TYPES ONLY.
 *
 * ⚠⚠ THIS MODULE EXISTS BECAUSE OF THE `'use server'` VALUE-EXPORT HAZARD. A `'use server'`
 * module may export ONLY async functions. An `export const` — or any exported non-async value
 * — fails `next build` with a runtime-shaped error while `tsc`, ESLint AND vitest all pass:
 * there is NO local gate that catches it, and it only fails once the module is reachable from
 * the client graph. That is the same reason `meeting-file-view-types.ts` exists one directory
 * up. Declaring the shapes here and importing them back with `import type` erases at compile
 * and emits nothing at all into the action modules.
 */

/** The uniform result both recap mutations return. The island toasts `error` verbatim. */
export type RecapActionResult = { success: true } | { success: false; error: string };
