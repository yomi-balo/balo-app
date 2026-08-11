'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { readConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import {
  mapMessageRowToView,
  mapFileRowToView,
  participantNames,
} from '@/lib/project-request/conversation-view';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/project-request/conversation-view-types';

const PAGE_SIZE = 30;

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  /** Exclusive keyset cursor — the OLDEST already-loaded message. */
  before: z
    .object({
      createdAtIso: z.iso.datetime(),
      id: z.uuid(),
    })
    .optional(),
  includeFiles: z.boolean(),
});

export type FetchThreadResult =
  | {
      success: true;
      messages: ConversationMessageView[];
      hasEarlier: boolean;
      files?: ConversationFileView[];
    }
  | { success: false; error: string };

/**
 * READ Server Action (BAL-271 / A4 — D6): tab switches + "Load earlier"
 * pagination. Follows the `search-experts-for-invite.ts` read-action precedent
 * (no frontend-called API route). Keyset pagination is strict
 * `(created_at, id) <` — no duplicates/gaps for same-timestamp messages.
 *
 * ⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` and sits on `onboarding-mutation-gate.test.ts`'s `READ_ONLY_ALLOWLIST`, so
 * it uses `readConversationAccess` (which `findByContext`s) rather than
 * `resolveConversationAccess` (which get-or-CREATES). The invariant test reads THIS file's
 * source and cannot see a write reached through an import, so the discipline lives here.
 */
export async function fetchThreadAction(
  input: z.infer<typeof inputSchema>
): Promise<FetchThreadResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId, before, includeFiles } = parsed.data;

  try {
    const access = await readConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    // A relationship with no conversation yet is an EMPTY thread, not an error — the read
    // reports it as such rather than provisioning one to avoid the branch.
    const { conversationId } = access;
    if (conversationId === undefined) {
      return {
        success: true,
        messages: [],
        hasEarlier: false,
        ...(includeFiles ? { files: [] } : {}),
      };
    }

    // ⚠ `scope: { kind: 'full' }` is STATED, never defaulted (BAL-424). Both parties read the
    // whole thread; the narrowed `{ kind: 'meeting' }` scope belongs to a meeting-level guest,
    // and a repository default would put that filter one forgotten argument from a disclosure.
    const [page, files] = await Promise.all([
      conversationsRepository.listMessagesPage({
        conversationId,
        scope: { kind: 'full' },
        before:
          before === undefined
            ? undefined
            : { createdAt: new Date(before.createdAtIso), id: before.id },
        limit: PAGE_SIZE,
      }),
      includeFiles
        ? conversationsRepository.listFiles(conversationId, { kind: 'full' })
        : Promise.resolve(null),
    ]);

    const result: FetchThreadResult = {
      success: true,
      messages: page.messages.map(mapMessageRowToView),
      hasEarlier: page.hasEarlier,
    };
    if (files !== null) {
      const names = participantNames(access.request, access.relationship);
      // Files panel reads newest-first; the repo returns oldest-first.
      result.files = files.map((file) => mapFileRowToView(file, names)).reverse();
    }
    return result;
  } catch (error) {
    log.error('Failed to fetch conversation thread', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not load this conversation. Please try again.' };
  }
}
