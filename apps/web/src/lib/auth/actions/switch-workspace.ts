'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Workspace } from '@balo/shared/workspaces';
import { switchWorkspace } from '@/lib/workspaces/switch-workspace';
import { requireOnboardedUser } from '@/lib/auth/session';
import { type AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

const targetKeySchema = z.string().min(1).max(64);

/**
 * BAL-494 — the switcher UI's (BAL-496) Server Action. `requireOnboardedUser()` is called IN
 * THIS FILE — mandatory: CLAUDE.md requires mutating web Server Actions to use it, and
 * `apps/web/src/invariants/onboarding-mutation-gate.test.ts` mechanically enforces it (a
 * scan, so it must literally be in this file, not just in the service it delegates to).
 *
 * This module's ONLY value export is `switchWorkspaceAction` (async) —
 * `apps/web/src/invariants/use-server-exports-only-async.test.ts` enforces that a `'use
 * server'` file may export only async functions.
 */
export async function switchWorkspaceAction(
  targetKey: string
): Promise<AuthResult<{ workspace: Workspace }>> {
  const parsed = targetKeySchema.safeParse(targetKey);
  if (!parsed.success) {
    return { success: false, error: 'Invalid workspace' };
  }

  // `const` + `.catch(() => null)` rather than a `let` assigned inside a try — a bare `let`
  // has no annotation and relies on TypeScript's evolving-`any` inference.
  const user = await requireOnboardedUser().catch(() => null);
  if (user === null) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    const result = await switchWorkspace(user, parsed.data, 'switcher');
    if (!result.ok) {
      return { success: false, error: 'Could not switch workspace. Please try again.' };
    }

    // The session drives nearly every RSC read — revalidate so a caller that forgets
    // router.refresh() still gets fresh data.
    revalidatePath('/', 'layout');

    return { success: true, data: { workspace: result.workspace } };
  } catch (error) {
    log.error('Workspace switch failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not switch workspace. Please try again.' };
  }
}
