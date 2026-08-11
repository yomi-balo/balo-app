import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  conversationContexts,
  conversationMessages,
  conversationFiles,
  conversationReadStates,
  conversations,
  meetings,
} from '../schema';
import {
  userFactory,
  requestExpertRelationshipFactory,
  caseEngagementFactory,
  conversationFactory,
  meetingFactory,
} from '../test/factories';
import { conversationsRepository, ConversationContextTakenError } from './conversations';

/** Every party call site states the full scope explicitly — see `listMessages`'s docblock. */
const FULL = { kind: 'full' } as const;

describe('conversationsRepository context seam', () => {
  it('I1 — ensureForContext is idempotent: same conversation, created:false, ONE live context row', async () => {
    const { engagement } = await caseEngagementFactory();
    // The case factory already provisioned a thread; soft-delete it so this test owns the
    // subject outright and the first `ensureForContext` is genuinely a create.
    await db
      .update(conversationContexts)
      .set({ deletedAt: new Date() })
      .where(eq(conversationContexts.contextId, engagement.id));

    const ref = { contextType: 'engagement' as const, contextId: engagement.id };
    const first = await conversationsRepository.ensureForContext(ref);
    const second = await conversationsRepository.ensureForContext(ref);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);

    const live = await db
      .select({ id: conversationContexts.id })
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.contextId, engagement.id),
          isNull(conversationContexts.deletedAt)
        )
      );
    expect(live).toHaveLength(1);

    // No orphan conversation was left behind by the losing insert.
    const allConversations = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, first.conversation.id));
    expect(allConversations).toHaveLength(1);
  });

  it('I2 — ensureForContext after the context row is SOFT-DELETED mints a NEW conversation', async () => {
    const { relationship, conversationId } = await requestExpertRelationshipFactory();
    const ref = { contextType: 'relationship' as const, contextId: relationship.id };

    const before = await conversationsRepository.findByContext(ref);
    expect(before?.id).toBe(conversationId);

    await db
      .update(conversationContexts)
      .set({ deletedAt: new Date() })
      .where(eq(conversationContexts.contextId, relationship.id));

    const after = await conversationsRepository.ensureForContext(ref);
    expect(after.created).toBe(true);
    expect(after.conversation.id).not.toBe(conversationId);
  });

  it('I3 — two conversations cannot claim the same live subject (attachContext throws; a raw insert violates the index)', async () => {
    const { relationship, conversationId } = await requestExpertRelationshipFactory();
    const other = await conversationFactory();

    await expect(
      conversationsRepository.attachContext({
        conversationId: other.conversation.id,
        contextType: 'relationship',
        contextId: relationship.id,
      })
    ).rejects.toThrow(ConversationContextTakenError);

    // Re-attaching the SAME conversation is an idempotent no-op, not an error.
    const reattached = await conversationsRepository.attachContext({
      conversationId,
      contextType: 'relationship',
      contextId: relationship.id,
    });
    expect(reattached.conversationId).toBe(conversationId);

    // The raw second live insert hits `conversation_context_subject_idx`. Wrapped in a
    // transaction so the violation aborts a SAVEPOINT, not the per-test transaction.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(conversationContexts).values({
          conversationId: other.conversation.id,
          contextType: 'relationship',
          contextId: relationship.id,
        });
      })
    ).rejects.toThrow();

    const live = await db
      .select({ conversationId: conversationContexts.conversationId })
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.contextId, relationship.id),
          isNull(conversationContexts.deletedAt)
        )
      );
    expect(live).toHaveLength(1);
  });

  it('I4 — carry-over: ONE conversation holds a live relationship row AND a live engagement row', async () => {
    const { relationship, conversationId } = await requestExpertRelationshipFactory();
    const { engagement } = await caseEngagementFactory();
    // Free the engagement subject the case factory already claimed, so the carry-over can
    // attach it to the RELATIONSHIP's thread — exactly what `materializeFromKickoff` does.
    await db
      .update(conversationContexts)
      .set({ deletedAt: new Date() })
      .where(eq(conversationContexts.contextId, engagement.id));

    await conversationsRepository.attachContext({
      conversationId,
      contextType: 'engagement',
      contextId: engagement.id,
    });

    const contexts = await conversationsRepository.listContexts(conversationId);
    expect(contexts.map((c) => c.contextType).sort()).toEqual(['engagement', 'relationship']);
    expect(contexts.map((c) => c.contextId).sort()).toEqual(
      [relationship.id, engagement.id].sort()
    );

    // Reachable from BOTH ends — the whole point of not removing the relationship context.
    expect(
      (
        await conversationsRepository.findByContext({
          contextType: 'relationship',
          contextId: relationship.id,
        })
      )?.id
    ).toBe(conversationId);
    expect(
      (
        await conversationsRepository.findByContext({
          contextType: 'engagement',
          contextId: engagement.id,
        })
      )?.id
    ).toBe(conversationId);
  });

  it('I5 — context_id is NOT NULL (23502), the deviation from meeting_contexts', async () => {
    const { conversation } = await conversationFactory();

    // Raw SQL: the Drizzle type forbids NULL, which is what we are pinning at the DB level.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO conversation_contexts (conversation_id, context_type, context_id)
          VALUES (${conversation.id}, 'engagement', NULL)
        `);
      })
    ).rejects.toThrow();
  });

  it('I16 — conversationIdsForContexts batches BOTH context types and omits misses', async () => {
    const rel = await requestExpertRelationshipFactory();
    const kase = await caseEngagementFactory();
    const missing = randomUUID();

    expect(await conversationsRepository.conversationIdsForContexts([])).toEqual(new Map());

    const found = await conversationsRepository.conversationIdsForContexts([
      { contextType: 'relationship', contextId: rel.relationship.id },
      { contextType: 'engagement', contextId: kase.engagement.id },
      { contextType: 'engagement', contextId: missing },
    ]);

    expect(found.get(`relationship:${rel.relationship.id}`)).toBe(rel.conversationId);
    expect(found.get(`engagement:${kase.engagement.id}`)).toBe(kase.conversationId);
    expect(found.has(`engagement:${missing}`)).toBe(false);
    expect(found.size).toBe(2);
  });

  it('ensureManyForContexts fills only the misses', async () => {
    const rel = await requestExpertRelationshipFactory();
    const kase = await caseEngagementFactory();
    await db
      .update(conversationContexts)
      .set({ deletedAt: new Date() })
      .where(eq(conversationContexts.contextId, kase.engagement.id));

    const map = await conversationsRepository.ensureManyForContexts([
      { contextType: 'relationship', contextId: rel.relationship.id },
      { contextType: 'engagement', contextId: kase.engagement.id },
    ]);

    expect(map.get(`relationship:${rel.relationship.id}`)).toBe(rel.conversationId);
    const minted = map.get(`engagement:${kase.engagement.id}`);
    expect(minted).toBeDefined();
    expect(minted).not.toBe(kase.conversationId);
  });

  it('AC — a Case engagement has a conversation and NO relationship context row anywhere', async () => {
    const { engagement, conversationId } = await caseEngagementFactory();

    const contexts = await conversationsRepository.listContexts(conversationId);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('engagement');
    expect(contexts[0]?.contextId).toBe(engagement.id);

    const relationshipRows = await db
      .select({ id: conversationContexts.id })
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.conversationId, conversationId),
          eq(conversationContexts.contextType, 'relationship')
        )
      );
    expect(relationshipRows).toHaveLength(0);
  });
});

describe('conversationsRepository messages', () => {
  it('posts a message and lists it', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();

    const msg = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>Hi, a quick question on scope.</p>',
    });

    expect(msg.conversationId).toBe(conversationId);
    expect(msg.senderUserId).toBe(sender.id);
    expect(msg.sentDuringMeetingId).toBeNull();

    const list = await conversationsRepository.listMessages(conversationId, FULL);
    expect(list.map((m) => m.id)).toContain(msg.id);
  });

  it('I6 — postMessage persists sentDuringMeetingId when given, NULL when omitted', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const { meeting } = await meetingFactory({ contexts: [] });

    const inCall = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>During the call.</p>',
      sentDuringMeetingId: meeting.id,
    });
    const between = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>Between calls.</p>',
    });

    expect(inCall.sentDuringMeetingId).toBe(meeting.id);
    expect(between.sentDuringMeetingId).toBeNull();
  });

  it('lists messages chronologically and excludes soft-deleted', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();

    const first = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>First.</p>',
    });
    const second = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>Second.</p>',
    });
    const deleted = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>Deleted.</p>',
    });
    await db
      .update(conversationMessages)
      .set({ deletedAt: new Date() })
      .where(eq(conversationMessages.id, deleted.id));

    const list = await conversationsRepository.listMessages(conversationId, FULL);
    const ids = list.map((m) => m.id);

    expect(ids).toEqual([first.id, second.id]); // chronological, deleted excluded
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1];
      const current = list[i];
      if (previous === undefined || current === undefined) throw new Error('unexpected gap');
      expect(previous.createdAt.getTime()).toBeLessThanOrEqual(current.createdAt.getTime());
    }
  });

  it('throws on a non-existent conversation id (FK)', async () => {
    const sender = await userFactory();
    await expect(
      conversationsRepository.postMessage({
        conversationId: randomUUID(),
        senderUserId: sender.id,
        body: '<p>No conversation.</p>',
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent sender id (FK)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    await expect(
      conversationsRepository.postMessage({
        conversationId,
        senderUserId: randomUUID(),
        body: '<p>No sender.</p>',
      })
    ).rejects.toThrow();
  });
});

describe('conversationsRepository files', () => {
  it('adds a file and lists it', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();

    const file = await conversationsRepository.addFile({
      conversationId,
      uploadedByUserId: uploader.id,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(file.conversationId).toBe(conversationId);
    expect(file.uploadedByUserId).toBe(uploader.id);

    const list = await conversationsRepository.listFiles(conversationId, FULL);
    expect(list.map((f) => f.id)).toContain(file.id);
  });

  it('rejects a duplicate r2_key (unique index)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();
    const dupKey = `conversation-files/${randomUUID()}`;

    await conversationsRepository.addFile({
      conversationId,
      uploadedByUserId: uploader.id,
      r2Key: dupKey,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });

    // The first file persisted — assert it BEFORE provoking the violation.
    const before = await conversationsRepository.listFiles(conversationId, FULL);
    expect(before).toHaveLength(1);

    // The unique r2_key index rejects the duplicate. This insert is a single un-wrapped
    // statement, so its failure aborts the surrounding per-test transaction; we therefore
    // make it the test's last DB action and never query after it (a post-abort query throws
    // "current transaction is aborted"). Mirrors the FK-violation tests in this file.
    await expect(
      conversationsRepository.addFile({
        conversationId,
        uploadedByUserId: uploader.id,
        r2Key: dupKey,
        fileName: 'b.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });

  it('excludes soft-deleted files from the list', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();
    const file = await conversationsRepository.addFile({
      conversationId,
      uploadedByUserId: uploader.id,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: 'gone.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });
    await db
      .update(conversationFiles)
      .set({ deletedAt: new Date() })
      .where(eq(conversationFiles.id, file.id));

    const list = await conversationsRepository.listFiles(conversationId, FULL);
    expect(list.map((f) => f.id)).not.toContain(file.id);
  });

  it('throws on a non-existent conversation id (FK)', async () => {
    const uploader = await userFactory();
    await expect(
      conversationsRepository.addFile({
        conversationId: randomUUID(),
        uploadedByUserId: uploader.id,
        r2Key: `conversation-files/${randomUUID()}`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent uploader id (FK)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    await expect(
      conversationsRepository.addFile({
        conversationId,
        uploadedByUserId: randomUUID(),
        r2Key: `conversation-files/${randomUUID()}`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });
});

/** Insert a message with a controlled `createdAt` (and optional fixed id / meeting). */
async function seedMessage(input: {
  conversationId: string;
  senderUserId: string;
  body: string;
  createdAt: Date;
  id?: string;
  deletedAt?: Date;
  sentDuringMeetingId?: string;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationMessages)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      conversationId: input.conversationId,
      senderUserId: input.senderUserId,
      body: input.body,
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
      ...(input.sentDuringMeetingId === undefined
        ? {}
        : { sentDuringMeetingId: input.sentDuringMeetingId }),
    })
    .returning({ id: conversationMessages.id, createdAt: conversationMessages.createdAt });
  if (row === undefined) throw new Error('seedMessage insert failed');
  return row;
}

/** Insert a file with a controlled `createdAt`. */
async function seedFile(input: {
  conversationId: string;
  uploadedByUserId: string;
  createdAt: Date;
  deletedAt?: Date;
  fileName?: string;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationFiles)
    .values({
      conversationId: input.conversationId,
      uploadedByUserId: input.uploadedByUserId,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: input.fileName ?? 'seed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    })
    .returning({ id: conversationFiles.id, createdAt: conversationFiles.createdAt });
  if (row === undefined) throw new Error('seedFile insert failed');
  return row;
}

describe('conversationsRepository.listMessagesPage', () => {
  it('pages newest-first via keyset, returns chronological ascending with sender names', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-01T00:00:00Z');
    for (let i = 1; i <= 5; i++) {
      await seedMessage({
        conversationId,
        senderUserId: sender.id,
        body: `<p>m${i}</p>`,
        createdAt: new Date(base + i * 1000),
      });
    }

    // Page 1 (no cursor): the NEWEST two, returned oldest→newest.
    const page1 = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      limit: 2,
    });
    expect(page1.hasEarlier).toBe(true);
    expect(page1.messages.map((m) => m.body)).toEqual(['<p>m4</p>', '<p>m5</p>']);
    const [page1Oldest] = page1.messages;
    if (page1Oldest === undefined) throw new Error('expected a first message on page 1');
    expect(page1Oldest.senderFirstName).toBe(sender.firstName);
    expect(page1Oldest.senderLastName).toBe(sender.lastName);

    // Page 2: strictly EARLIER than page 1's oldest — no overlap.
    const page2 = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      before: { createdAt: page1Oldest.createdAt, id: page1Oldest.id },
      limit: 2,
    });
    expect(page2.hasEarlier).toBe(true);
    expect(page2.messages.map((m) => m.body)).toEqual(['<p>m2</p>', '<p>m3</p>']);

    // Page 3: the final remainder — hasEarlier flips false.
    const [page2Oldest] = page2.messages;
    if (page2Oldest === undefined) throw new Error('expected a first message on page 2');
    const page3 = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      before: { createdAt: page2Oldest.createdAt, id: page2Oldest.id },
      limit: 2,
    });
    expect(page3.hasEarlier).toBe(false);
    expect(page3.messages.map((m) => m.body)).toEqual(['<p>m1</p>']);
  });

  it('breaks same-timestamp ties by id — no duplicates or gaps across pages', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const at = new Date('2026-06-02T00:00:00Z');
    const idA = '00000000-0000-4000-8000-00000000000a';
    const idB = '00000000-0000-4000-8000-00000000000b';
    const idC = '00000000-0000-4000-8000-00000000000c';
    for (const id of [idA, idB, idC]) {
      await seedMessage({
        conversationId,
        senderUserId: sender.id,
        body: `<p>${id}</p>`,
        createdAt: at,
        id,
      });
    }

    // Internal order is (created_at DESC, id DESC) → c, b, a. Page of 2 → [c, b] →
    // chronological [b, c].
    const page1 = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      limit: 2,
    });
    expect(page1.messages.map((m) => m.id)).toEqual([idB, idC]);
    expect(page1.hasEarlier).toBe(true);

    // Cursor on (same timestamp, idB) → strict tuple < returns only idA.
    const [oldest] = page1.messages;
    if (oldest === undefined) throw new Error('expected a first message on page 1');
    const page2 = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      before: { createdAt: oldest.createdAt, id: oldest.id },
      limit: 2,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([idA]);
    expect(page2.hasEarlier).toBe(false);
  });

  it('excludes soft-deleted messages from pages and from hasEarlier', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-03T00:00:00Z');
    const live1 = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>live-1</p>',
      createdAt: new Date(base),
    });
    await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 1000),
      deletedAt: new Date(),
    });
    const live2 = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>live-2</p>',
      createdAt: new Date(base + 2000),
    });

    // 2 live + 1 deleted with limit 2: the deleted row must not appear AND must not count
    // as an "earlier" row.
    const page = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      limit: 2,
    });
    expect(page.messages.map((m) => m.id)).toEqual([live1.id, live2.id]);
    expect(page.hasEarlier).toBe(false);
  });
});

describe('the meeting-level guest read filter', () => {
  it('I7/I9 — a meeting scope returns EXACTLY that call, excluding NULL-meeting messages; full returns all', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const meetingA = (await meetingFactory({ contexts: [] })).meeting;
    const meetingB = (await meetingFactory({ contexts: [] })).meeting;
    const base = Date.parse('2026-06-10T00:00:00Z');

    const duringA = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>in call A</p>',
      createdAt: new Date(base),
      sentDuringMeetingId: meetingA.id,
    });
    const duringB = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>in call B</p>',
      createdAt: new Date(base + 1000),
      sentDuringMeetingId: meetingB.id,
    });
    const betweenCalls = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>between calls</p>',
      createdAt: new Date(base + 2000),
    });

    const scopedList = await conversationsRepository.listMessages(conversationId, {
      kind: 'meeting',
      meetingId: meetingA.id,
    });
    expect(scopedList.map((m) => m.id)).toEqual([duringA.id]);

    const scopedPage = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: { kind: 'meeting', meetingId: meetingA.id },
      limit: 50,
    });
    expect(scopedPage.messages.map((m) => m.id)).toEqual([duringA.id]);
    // The NULL-meeting message is EXCLUDED — the security AC.
    expect(scopedPage.messages.map((m) => m.id)).not.toContain(betweenCalls.id);
    expect(scopedPage.messages.map((m) => m.id)).not.toContain(duringB.id);

    const full = await conversationsRepository.listMessagesPage({
      conversationId,
      scope: FULL,
      limit: 50,
    });
    expect(full.messages.map((m) => m.id)).toEqual([duringA.id, duringB.id, betweenCalls.id]);
  });

  it('I8 — listFiles under a meeting scope returns [] even when live files exist', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();
    const { meeting } = await meetingFactory({ contexts: [] });
    await seedFile({
      conversationId,
      uploadedByUserId: uploader.id,
      createdAt: new Date('2026-06-11T00:00:00Z'),
    });

    expect(await conversationsRepository.listFiles(conversationId, FULL)).toHaveLength(1);
    expect(
      await conversationsRepository.listFiles(conversationId, {
        kind: 'meeting',
        meetingId: meeting.id,
      })
    ).toEqual([]);
  });

  it('I10 — deleting the meeting SET-NULLs the column, the message survives, and it falls OUT of a meeting scope', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const { meeting } = await meetingFactory({ contexts: [] });
    const message = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>in call</p>',
      createdAt: new Date('2026-06-12T00:00:00Z'),
      sentDuringMeetingId: meeting.id,
    });

    await db.delete(meetings).where(eq(meetings.id, meeting.id));

    const survivors = await conversationsRepository.listMessages(conversationId, FULL);
    expect(survivors.map((m) => m.id)).toEqual([message.id]);
    expect(survivors[0]?.sentDuringMeetingId).toBeNull();

    // FAIL-CLOSED DIRECTION: nulling REMOVES visibility rather than granting it.
    expect(
      await conversationsRepository.listMessages(conversationId, {
        kind: 'meeting',
        meetingId: meeting.id,
      })
    ).toEqual([]);
  });
});

describe('conversationsRepository.listThreadSummaries', () => {
  it('returns [] for empty input and the zero shape for an empty thread', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();

    expect(
      await conversationsRepository.listThreadSummaries({
        conversationIds: [],
        viewerUserId: viewer.id,
      })
    ).toEqual([]);

    const summaries = await conversationsRepository.listThreadSummaries({
      conversationIds: [conversationId],
      viewerUserId: viewer.id,
    });
    expect(summaries).toEqual([
      {
        conversationId,
        latestMessage: null,
        latestInboundActivityAt: null,
        fileCount: 0,
        lastReadAt: null,
      },
    ]);
  });

  it('I12 — batches N threads in input order: latest any-sender message, inbound excludes viewer, files count toward inbound', async () => {
    const viewer = await userFactory({ firstName: 'Priya' });
    const other = await userFactory();
    const a = await requestExpertRelationshipFactory();
    const b = await requestExpertRelationshipFactory();
    const base = Date.parse('2026-06-04T00:00:00Z');

    // Thread A: other m1 → viewer m2 (newest message) → other FILE (newest inbound
    // overall) — and the viewer marked read in between.
    await seedMessage({
      conversationId: a.conversationId,
      senderUserId: other.id,
      body: '<p>a-inbound</p>',
      createdAt: new Date(base),
    });
    const aViewerMsg = await seedMessage({
      conversationId: a.conversationId,
      senderUserId: viewer.id,
      body: '<p>a-own-latest</p>',
      createdAt: new Date(base + 1000),
    });
    const aInboundFile = await seedFile({
      conversationId: a.conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 2000),
    });
    const aReadAt = new Date(base + 500);
    await conversationsRepository.markThreadRead({
      conversationId: a.conversationId,
      userId: viewer.id,
      at: aReadAt,
    });

    // Thread B: file-only — other's file at base, viewer's NEWER file at base+1000 (own
    // activity must not count as inbound; both count for size).
    const bInboundFile = await seedFile({
      conversationId: b.conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date(base),
    });
    await seedFile({
      conversationId: b.conversationId,
      uploadedByUserId: viewer.id,
      createdAt: new Date(base + 1000),
    });

    const summaries = await conversationsRepository.listThreadSummaries({
      conversationIds: [a.conversationId, b.conversationId],
      viewerUserId: viewer.id,
    });
    expect(summaries.map((s) => s.conversationId)).toEqual([a.conversationId, b.conversationId]);
    const [summaryA, summaryB] = summaries;
    if (summaryA === undefined || summaryB === undefined) {
      throw new Error('expected one summary per input id');
    }

    // A: preview = newest message ANY sender (the viewer's own); inbound = the other
    // party's newer FILE (max across message/file legs).
    expect(summaryA.latestMessage?.id).toBe(aViewerMsg.id);
    expect(summaryA.latestMessage?.senderUserId).toBe(viewer.id);
    expect(summaryA.latestMessage?.senderFirstName).toBe('Priya');
    expect(summaryA.latestInboundActivityAt?.getTime()).toBe(aInboundFile.createdAt.getTime());
    expect(summaryA.fileCount).toBe(1);
    expect(summaryA.lastReadAt?.getTime()).toBe(aReadAt.getTime());

    // B: no messages at all; inbound = the OTHER party's older file (the viewer's newer
    // upload is excluded); fileCount counts both.
    expect(summaryB.latestMessage).toBeNull();
    expect(summaryB.latestInboundActivityAt?.getTime()).toBe(bInboundFile.createdAt.getTime());
    expect(summaryB.fileCount).toBe(2);
    expect(summaryB.lastReadAt).toBeNull();

    // Unknown ids still get exactly one empty element, in input order.
    const unknown = randomUUID();
    const withUnknown = await conversationsRepository.listThreadSummaries({
      conversationIds: [unknown, a.conversationId],
      viewerUserId: viewer.id,
    });
    expect(withUnknown.map((s) => s.conversationId)).toEqual([unknown, a.conversationId]);
    expect(withUnknown[0]?.latestMessage).toBeNull();
    expect(withUnknown[0]?.fileCount).toBe(0);
  });

  it('excludes soft-deleted messages, files, and read states from every leg', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const other = await userFactory({ firstName: 'Dana' });
    const base = Date.parse('2026-06-05T00:00:00Z');

    const liveMsg = await seedMessage({
      conversationId,
      senderUserId: other.id,
      body: '<p>live</p>',
      createdAt: new Date(base),
    });
    // Newer but soft-deleted message/file must influence NOTHING.
    await seedMessage({
      conversationId,
      senderUserId: other.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 1000),
      deletedAt: new Date(),
    });
    await seedFile({
      conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 2000),
      deletedAt: new Date(),
    });
    // Soft-deleted read state for the viewer → lastReadAt null.
    await db.insert(conversationReadStates).values({
      conversationId,
      userId: viewer.id,
      lastReadAt: new Date(base),
      deletedAt: new Date(),
    });
    // ANOTHER user's live read state must not leak into the viewer's summary.
    await conversationsRepository.markThreadRead({
      conversationId,
      userId: other.id,
      at: new Date(base + 3000),
    });

    const summaries = await conversationsRepository.listThreadSummaries({
      conversationIds: [conversationId],
      viewerUserId: viewer.id,
    });
    const [summary] = summaries;
    if (summary === undefined) throw new Error('expected one summary');

    expect(summary.latestMessage?.id).toBe(liveMsg.id);
    expect(summary.latestMessage?.senderFirstName).toBe('Dana');
    expect(summary.latestInboundActivityAt?.getTime()).toBe(liveMsg.createdAt.getTime());
    expect(summary.fileCount).toBe(0);
    expect(summary.lastReadAt).toBeNull();
  });

  it('I13 — excludes a SOFT-DELETED conversation (the behaviour change from driving off `conversations`)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>hello</p>',
      createdAt: new Date('2026-06-13T00:00:00Z'),
    });

    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    const summaries = await conversationsRepository.listThreadSummaries({
      conversationIds: [conversationId],
      viewerUserId: sender.id,
    });
    // One element per INPUT id is still the contract — but it is the EMPTY shape.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.latestMessage).toBeNull();
    expect(summaries[0]?.fileCount).toBe(0);
  });
});

describe('conversationsRepository.latestMessagesForRelationships', () => {
  it('I14 — newest live message per relationship, skips relationships with none, empty input ⇒ no query', async () => {
    expect(await conversationsRepository.latestMessagesForRelationships([])).toEqual(new Map());

    const withMessages = await requestExpertRelationshipFactory();
    const withoutMessages = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-14T00:00:00Z');

    await seedMessage({
      conversationId: withMessages.conversationId,
      senderUserId: sender.id,
      body: '<p>older</p>',
      createdAt: new Date(base),
    });
    const newest = await seedMessage({
      conversationId: withMessages.conversationId,
      senderUserId: sender.id,
      body: '<p>newest</p>',
      createdAt: new Date(base + 2000),
    });
    // A newer SOFT-DELETED message must not win.
    await seedMessage({
      conversationId: withMessages.conversationId,
      senderUserId: sender.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 3000),
      deletedAt: new Date(),
    });

    const map = await conversationsRepository.latestMessagesForRelationships([
      withMessages.relationship.id,
      withoutMessages.relationship.id,
      randomUUID(),
    ]);

    expect(map.get(withMessages.relationship.id)?.id).toBe(newest.id);
    expect(map.get(withMessages.relationship.id)?.createdAt.getTime()).toBe(base + 2000);
    expect(map.has(withoutMessages.relationship.id)).toBe(false);
    expect(map.size).toBe(1);
  });

  it('never reaches an ENGAGEMENT-anchored thread through the relationship label', async () => {
    const { relationship, conversationId } = await requestExpertRelationshipFactory();
    const { engagement } = await caseEngagementFactory();
    const sender = await userFactory();

    // Carry-over: the SAME conversation also names the engagement.
    await db
      .update(conversationContexts)
      .set({ deletedAt: new Date() })
      .where(eq(conversationContexts.contextId, engagement.id));
    await conversationsRepository.attachContext({
      conversationId,
      contextType: 'engagement',
      contextId: engagement.id,
    });
    const message = await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>carried over</p>',
      createdAt: new Date('2026-06-15T00:00:00Z'),
    });

    // Looked up by RELATIONSHIP id — exactly one entry, not two.
    const map = await conversationsRepository.latestMessagesForRelationships([
      relationship.id,
      engagement.id,
    ]);
    expect(map.get(relationship.id)?.id).toBe(message.id);
    expect(map.has(engagement.id)).toBe(false);
  });
});

describe('conversationsRepository.unreadSummaryFor', () => {
  it('I15 — counts only OTHER users activity strictly after the watermark; no watermark counts everything', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const other = await userFactory();
    const base = Date.parse('2026-06-16T00:00:00Z');

    await seedMessage({
      conversationId,
      senderUserId: other.id,
      body: '<p>inbound-1</p>',
      createdAt: new Date(base),
    });
    await seedMessage({
      conversationId,
      senderUserId: viewer.id,
      body: '<p>own</p>',
      createdAt: new Date(base + 1000),
    });
    const inbound2 = await seedMessage({
      conversationId,
      senderUserId: other.id,
      body: '<p>inbound-2</p>',
      createdAt: new Date(base + 2000),
    });

    // No watermark yet → everything inbound counts.
    const noWatermark = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(noWatermark.unreadMessageCount).toBe(2);
    expect(noWatermark.unreadFileCount).toBe(0);
    expect(noWatermark.latestInboundAt?.getTime()).toBe(base + 2000);
    expect(noWatermark.latestInboundSenderUserId).toBe(other.id);
    expect(noWatermark.latestInboundBody).toBe('<p>inbound-2</p>');
    expect(noWatermark.latestInboundFileName).toBeNull();

    // Watermark between the two inbound messages → only the later one counts.
    await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: new Date(base + 1500),
    });
    const partial = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(partial.unreadMessageCount).toBe(1);
    expect(partial.latestInboundAt?.getTime()).toBe(inbound2.createdAt.getTime());

    // Watermark past everything → zero, and the digest guard skips.
    await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: new Date(base + 9000),
    });
    const caughtUp = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(caughtUp.unreadMessageCount).toBe(0);
    expect(caughtUp.unreadFileCount).toBe(0);
    expect(caughtUp.latestInboundAt).toBeNull();
    expect(caughtUp.latestInboundBody).toBeNull();
    expect(caughtUp.latestInboundFileName).toBeNull();
  });

  it('I15b — a FILE-ONLY exchange still reports unread (the regression that produced no email, ever)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const other = await userFactory();

    const file = await seedFile({
      conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date('2026-06-17T00:00:00Z'),
      fileName: 'architecture.pdf',
    });

    const summary = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(summary.unreadMessageCount).toBe(0);
    expect(summary.unreadFileCount).toBe(1);
    expect(summary.latestInboundAt?.getTime()).toBe(file.createdAt.getTime());
    expect(summary.latestInboundSenderUserId).toBe(other.id);
    expect(summary.latestInboundBody).toBeNull();
    expect(summary.latestInboundFileName).toBe('architecture.pdf');
  });

  /**
   * BAL-424 — `distinctInboundSenderCount` is what lets the digest decide whether it may
   * honestly NAME a sender. A coalesced 10-minute window legitimately spans two people, and
   * naming only the newest would misattribute everything the other one wrote.
   */
  it('I15d — distinctInboundSenderCount counts PEOPLE across both legs, not rows', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const priya = await userFactory();
    const marcus = await userFactory();

    // Priya writes twice AND shares a file — still ONE distinct sender.
    await seedMessage({
      conversationId,
      senderUserId: priya.id,
      body: '<p>from priya</p>',
      createdAt: new Date('2026-06-17T00:00:00Z'),
    });
    await seedMessage({
      conversationId,
      senderUserId: priya.id,
      body: '<p>from priya</p>',
      createdAt: new Date('2026-06-17T00:01:00Z'),
    });
    await seedFile({
      conversationId,
      uploadedByUserId: priya.id,
      createdAt: new Date('2026-06-17T00:02:00Z'),
    });

    const onePerson = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(onePerson.unreadMessageCount).toBe(2);
    expect(onePerson.unreadFileCount).toBe(1);
    expect(onePerson.distinctInboundSenderCount).toBe(1);

    // A second person joins the window ⇒ two.
    await seedMessage({
      conversationId,
      senderUserId: marcus.id,
      body: '<p>from marcus</p>',
      createdAt: new Date('2026-06-17T00:03:00Z'),
    });
    const twoPeople = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(twoPeople.distinctInboundSenderCount).toBe(2);

    // The VIEWER's own activity is never inbound, so it never inflates the count.
    await seedMessage({
      conversationId,
      senderUserId: viewer.id,
      body: '<p>from viewer</p>',
      createdAt: new Date('2026-06-17T00:04:00Z'),
    });
    const stillTwo = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(stillTwo.distinctInboundSenderCount).toBe(2);
  });

  it('I15e — distinctInboundSenderCount is 0 when nothing is unread', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const summary = await conversationsRepository.unreadSummaryFor({
      conversationId,
      viewerUserId: viewer.id,
    });
    expect(summary.distinctInboundSenderCount).toBe(0);
    expect(summary.latestInboundAt).toBeNull();
  });

  it('I15c — latestInboundAt agrees with listThreadSummaries across all four combinations', async () => {
    const viewer = await userFactory();
    const other = await userFactory();
    const base = Date.parse('2026-06-18T00:00:00Z');

    const messageOnly = await requestExpertRelationshipFactory();
    await seedMessage({
      conversationId: messageOnly.conversationId,
      senderUserId: other.id,
      body: '<p>m</p>',
      createdAt: new Date(base),
    });

    const fileOnly = await requestExpertRelationshipFactory();
    await seedFile({
      conversationId: fileOnly.conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 1000),
    });

    const both = await requestExpertRelationshipFactory();
    await seedMessage({
      conversationId: both.conversationId,
      senderUserId: other.id,
      body: '<p>m</p>',
      createdAt: new Date(base + 2000),
    });
    await seedFile({
      conversationId: both.conversationId,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 3000),
    });

    const neither = await requestExpertRelationshipFactory();

    const ids = [
      messageOnly.conversationId,
      fileOnly.conversationId,
      both.conversationId,
      neither.conversationId,
    ];
    const summaries = await conversationsRepository.listThreadSummaries({
      conversationIds: ids,
      viewerUserId: viewer.id,
    });

    for (const [index, conversationId] of ids.entries()) {
      const summary = summaries[index];
      if (summary === undefined) throw new Error('expected one summary per input id');
      const unread = await conversationsRepository.unreadSummaryFor({
        conversationId,
        viewerUserId: viewer.id,
      });
      expect(unread.latestInboundAt?.getTime() ?? null).toBe(
        summary.latestInboundActivityAt?.getTime() ?? null
      );
    }
  });
});

describe('conversationsRepository.markThreadRead', () => {
  it('inserts a fresh watermark for a first mark', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const at = new Date('2026-06-06T00:00:00Z');

    const row = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at,
    });

    expect(row.conversationId).toBe(conversationId);
    expect(row.userId).toBe(viewer.id);
    expect(row.lastReadAt.getTime()).toBe(at.getTime());
    expect(row.deletedAt).toBeNull();
  });

  it('I11 — advances on a newer mark and never regresses on an older one (GREATEST)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const t1 = new Date('2026-06-06T10:00:00Z');
    const t2 = new Date('2026-06-06T11:00:00Z');

    const first = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: t1,
    });
    // Newer mark → conflict path on the partial unique index updates the SAME row forward.
    const advanced = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: t2,
    });
    expect(advanced.id).toBe(first.id);
    expect(advanced.lastReadAt.getTime()).toBe(t2.getTime());

    // Older (out-of-order/concurrent) mark → watermark must NOT move back.
    const noRegress = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: t1,
    });
    expect(noRegress.id).toBe(first.id);
    expect(noRegress.lastReadAt.getTime()).toBe(t2.getTime());

    // Still exactly one live row for (conversation, user).
    const rows = await db
      .select()
      .from(conversationReadStates)
      .where(
        and(
          eq(conversationReadStates.conversationId, conversationId),
          eq(conversationReadStates.userId, viewer.id)
        )
      );
    expect(rows).toHaveLength(1);
  });

  it('re-creates a fresh row after soft delete (partial unique frees the slot)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();

    const first = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: new Date('2026-06-07T00:00:00Z'),
    });
    await db
      .update(conversationReadStates)
      .set({ deletedAt: new Date() })
      .where(eq(conversationReadStates.id, first.id));

    // The soft-deleted row no longer occupies the (partial) unique slot — the next mark
    // INSERTS a new live row instead of silently failing.
    const at = new Date('2026-06-07T01:00:00Z');
    const second = await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.lastReadAt.getTime()).toBe(at.getTime());
    expect(second.deletedAt).toBeNull();
  });

  it('rejects a second LIVE row at the DB level (partial unique index)', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    await conversationsRepository.markThreadRead({
      conversationId,
      userId: viewer.id,
      at: new Date('2026-06-08T00:00:00Z'),
    });

    // A raw second live insert hits `conversation_read_state_unique_idx`. Wrapped in
    // db.transaction() so the violation aborts a SAVEPOINT, not the per-test transaction.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(conversationReadStates).values({
          conversationId,
          userId: viewer.id,
          lastReadAt: new Date('2026-06-08T01:00:00Z'),
        });
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(conversationReadStates)
      .where(
        and(
          eq(conversationReadStates.conversationId, conversationId),
          eq(conversationReadStates.userId, viewer.id)
        )
      );
    expect(rows).toHaveLength(1);
  });

  it('throws on a non-existent conversation id (FK)', async () => {
    const viewer = await userFactory();
    await expect(
      conversationsRepository.markThreadRead({
        conversationId: randomUUID(),
        userId: viewer.id,
        at: new Date(),
      })
    ).rejects.toThrow();
  });
});

describe('conversationsRepository.countThreadActivity', () => {
  it('counts live messages and files for the thread, any sender/uploader, scoped to the conversation', async () => {
    const a = await requestExpertRelationshipFactory();
    const b = await requestExpertRelationshipFactory();
    const client = await userFactory();
    const expert = await userFactory();
    const base = Date.parse('2026-06-09T00:00:00Z');

    // Thread A: two messages from DIFFERENT senders + one file.
    await seedMessage({
      conversationId: a.conversationId,
      senderUserId: client.id,
      body: '<p>from client</p>',
      createdAt: new Date(base),
    });
    await seedMessage({
      conversationId: a.conversationId,
      senderUserId: expert.id,
      body: '<p>from expert</p>',
      createdAt: new Date(base + 1000),
    });
    await seedFile({
      conversationId: a.conversationId,
      uploadedByUserId: expert.id,
      createdAt: new Date(base + 2000),
    });

    // Thread B: noise that must NOT leak into A's counts.
    await seedMessage({
      conversationId: b.conversationId,
      senderUserId: client.id,
      body: '<p>other thread</p>',
      createdAt: new Date(base),
    });
    await seedFile({
      conversationId: b.conversationId,
      uploadedByUserId: client.id,
      createdAt: new Date(base + 1000),
    });

    expect(await conversationsRepository.countThreadActivity(a.conversationId)).toEqual({
      messageCount: 2,
      fileCount: 1,
    });
    expect(await conversationsRepository.countThreadActivity(b.conversationId)).toEqual({
      messageCount: 1,
      fileCount: 1,
    });
  });

  it('excludes soft-deleted messages and files', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-09T01:00:00Z');

    await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>live</p>',
      createdAt: new Date(base),
    });
    await seedMessage({
      conversationId,
      senderUserId: sender.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 1000),
      deletedAt: new Date(),
    });
    await seedFile({
      conversationId,
      uploadedByUserId: sender.id,
      createdAt: new Date(base + 2000),
      deletedAt: new Date(),
    });

    expect(await conversationsRepository.countThreadActivity(conversationId)).toEqual({
      messageCount: 1,
      fileCount: 0,
    });
  });

  it('returns zeros for an empty thread and for an unknown conversation id', async () => {
    const { conversationId } = await requestExpertRelationshipFactory();

    expect(await conversationsRepository.countThreadActivity(conversationId)).toEqual({
      messageCount: 0,
      fileCount: 0,
    });
    // COUNT over no rows — a bad id is zeros, never a throw.
    expect(await conversationsRepository.countThreadActivity(randomUUID())).toEqual({
      messageCount: 0,
      fileCount: 0,
    });
  });
});

describe('BAL-424 invariants', () => {
  it('conversation_messages has NO party / senderRole column — role is derived at read time', () => {
    const columns = Object.keys(conversationMessages);
    expect(columns).not.toContain('party');
    expect(columns).not.toContain('senderRole');
    expect(columns).toContain('senderUserId');
  });
});
