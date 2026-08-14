'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository, usersRepository } from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { requireUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import {
  mapConversationFileRowToView,
  mapMessageRowToView,
} from '@/lib/conversations/conversation-view';
import type { FetchCaseThreadResult } from './_types/case-action-types';

const PAGE_SIZE = 30;

const inputSchema = z
  .object({
    engagementId: z.uuid(),
    /** Exclusive keyset cursor — the OLDEST already-loaded message. */
    before: z
      .object({
        createdAtIso: z.iso.datetime(),
        id: z.uuid(),
      })
      .optional(),
    includeFiles: z.boolean(),
  })
  .strict();

/**
 * BAL-421 — the case thread's "Show earlier messages" pagination, as a READ Server Action.
 * Keyset pagination is strict `(created_at, id) <`, so there are no duplicates or gaps across
 * same-timestamp messages.
 *
 * ⚠⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` — a pre-onboarding session may legitimately read — and therefore sits on
 * `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`. `onboarding-mutation-gate.test.ts` reads
 * THIS FILE'S SOURCE and cannot see a write reached through an import, so the discipline lives
 * here: `resolveCaseAccess` reaches `authorizeEngagementConversation`, whose thread read is
 * `conversationsRepository.findByContext` — a SELECT. It must NEVER become `ensureForContext`
 * / `ensureManyForContexts`: minting a conversation row from a READ path is exactly the
 * transitive-write defect BAL-424 closed, and it would do it behind a bare `requireUser()`.
 *
 * ⚠ NO WRITABILITY CHECK, DELIBERATELY. A CLOSED case is fully READABLE — read access and
 * write access are separate questions, and only `postCaseMessageAction` composes
 * `conversationWritable`.
 */
export async function fetchCaseThreadAction(
  input: z.infer<typeof inputSchema>
): Promise<FetchCaseThreadResult> {
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
  const { engagementId, before, includeFiles } = parsed.data;

  try {
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }
    const { conversationId } = access;

    const [page, files] = await Promise.all([
      conversationsRepository.listMessagesPage({
        conversationId,
        // ⚠ STATED, NEVER DEFAULTED. Both parties read the whole thread; the narrowed
        // `{ kind: 'meeting' }` scope belongs to a meeting-level guest, and a repository
        // default would put that filter one forgotten argument from a disclosure.
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

    const result: FetchCaseThreadResult = {
      success: true,
      messages: page.messages.map(mapMessageRowToView),
      hasEarlier: page.hasEarlier,
    };

    if (files !== null) {
      // ONE batched query over the distinct uploader set — never one per file. Projects
      // `id / firstName / lastName` only; never `email` or `workosId` (ADR-1044).
      const uploaderIds = [...new Set(files.map((file) => file.uploadedByUserId))];
      const people =
        uploaderIds.length === 0 ? [] : await usersRepository.findNamesByIds(uploaderIds);
      const nameById = new Map(
        people.map((person) => [
          person.id,
          personDisplayName(person.firstName, person.lastName, 'Participant'),
        ])
      );
      // The repository returns oldest-first; the files panel reads newest-first.
      result.files = files.map((file) => mapConversationFileRowToView(file, nameById)).reverse();
    }

    return result;
  } catch (error) {
    log.error('Failed to fetch case conversation thread', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not load this conversation. Please try again.' };
  }
}
