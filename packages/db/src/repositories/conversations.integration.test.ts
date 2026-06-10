import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { conversationMessages, conversationFiles, conversationReadStates } from '../schema';
import { userFactory, requestExpertRelationshipFactory } from '../test/factories';
import { conversationsRepository } from './conversations';

describe('conversationsRepository messages', () => {
  it('posts a message and lists it', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const sender = await userFactory();

    const msg = await conversationsRepository.postMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>Hi, a quick question on scope.</p>',
    });

    expect(msg.relationshipId).toBe(relationship.id);
    expect(msg.senderUserId).toBe(sender.id);

    const list = await conversationsRepository.listMessages(relationship.id);
    expect(list.map((m) => m.id)).toContain(msg.id);
  });

  it('lists messages chronologically and excludes soft-deleted', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const sender = await userFactory();

    const first = await conversationsRepository.postMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>First.</p>',
    });
    const second = await conversationsRepository.postMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>Second.</p>',
    });
    const deleted = await conversationsRepository.postMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>Deleted.</p>',
    });
    await db
      .update(conversationMessages)
      .set({ deletedAt: new Date() })
      .where(eq(conversationMessages.id, deleted.id));

    const list = await conversationsRepository.listMessages(relationship.id);
    const ids = list.map((m) => m.id);

    expect(ids).toEqual([first.id, second.id]); // chronological, deleted excluded
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.createdAt.getTime()).toBeLessThanOrEqual(list[i]!.createdAt.getTime());
    }
  });

  it('throws on a non-existent relationship id (FK)', async () => {
    const sender = await userFactory();
    await expect(
      conversationsRepository.postMessage({
        relationshipId: randomUUID(),
        senderUserId: sender.id,
        body: '<p>No relationship.</p>',
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent sender id (FK)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    await expect(
      conversationsRepository.postMessage({
        relationshipId: relationship.id,
        senderUserId: randomUUID(),
        body: '<p>No sender.</p>',
      })
    ).rejects.toThrow();
  });
});

describe('conversationsRepository files', () => {
  it('adds a file and lists it', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();

    const file = await conversationsRepository.addFile({
      relationshipId: relationship.id,
      uploadedByUserId: uploader.id,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(file.relationshipId).toBe(relationship.id);
    expect(file.uploadedByUserId).toBe(uploader.id);

    const list = await conversationsRepository.listFiles(relationship.id);
    expect(list.map((f) => f.id)).toContain(file.id);
  });

  it('rejects a duplicate r2_key (unique index)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();
    const dupKey = `conversation-files/${randomUUID()}`;

    await conversationsRepository.addFile({
      relationshipId: relationship.id,
      uploadedByUserId: uploader.id,
      r2Key: dupKey,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });

    // The first file persisted — assert it BEFORE provoking the violation.
    const before = await conversationsRepository.listFiles(relationship.id);
    expect(before).toHaveLength(1);

    // The unique r2_key index rejects the duplicate. This insert is a single
    // un-wrapped statement, so its failure aborts the surrounding per-test
    // transaction; we therefore make it the test's last DB action and never
    // query after it (a post-abort query throws "current transaction is
    // aborted"). Mirrors the FK-violation tests in this file.
    await expect(
      conversationsRepository.addFile({
        relationshipId: relationship.id,
        uploadedByUserId: uploader.id,
        r2Key: dupKey,
        fileName: 'b.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });

  it('excludes soft-deleted files from the list', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const uploader = await userFactory();
    const file = await conversationsRepository.addFile({
      relationshipId: relationship.id,
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

    const list = await conversationsRepository.listFiles(relationship.id);
    expect(list.map((f) => f.id)).not.toContain(file.id);
  });

  it('throws on a non-existent relationship id (FK)', async () => {
    const uploader = await userFactory();
    await expect(
      conversationsRepository.addFile({
        relationshipId: randomUUID(),
        uploadedByUserId: uploader.id,
        r2Key: `conversation-files/${randomUUID()}`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent uploader id (FK)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    await expect(
      conversationsRepository.addFile({
        relationshipId: relationship.id,
        uploadedByUserId: randomUUID(),
        r2Key: `conversation-files/${randomUUID()}`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
    ).rejects.toThrow();
  });
});

/** Insert a message with a controlled `createdAt` (and optional fixed id). */
async function seedMessage(input: {
  relationshipId: string;
  senderUserId: string;
  body: string;
  createdAt: Date;
  id?: string;
  deletedAt?: Date;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationMessages)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      relationshipId: input.relationshipId,
      senderUserId: input.senderUserId,
      body: input.body,
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    })
    .returning({ id: conversationMessages.id, createdAt: conversationMessages.createdAt });
  if (row === undefined) throw new Error('seedMessage insert failed');
  return row;
}

/** Insert a file with a controlled `createdAt`. */
async function seedFile(input: {
  relationshipId: string;
  uploadedByUserId: string;
  createdAt: Date;
  deletedAt?: Date;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(conversationFiles)
    .values({
      relationshipId: input.relationshipId,
      uploadedByUserId: input.uploadedByUserId,
      r2Key: `conversation-files/${randomUUID()}`,
      fileName: 'seed.pdf',
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
    const { relationship } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-01T00:00:00Z');
    for (let i = 1; i <= 5; i++) {
      await seedMessage({
        relationshipId: relationship.id,
        senderUserId: sender.id,
        body: `<p>m${i}</p>`,
        createdAt: new Date(base + i * 1000),
      });
    }

    // Page 1 (no cursor): the NEWEST two, returned oldest→newest.
    const page1 = await conversationsRepository.listMessagesPage({
      relationshipId: relationship.id,
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
      relationshipId: relationship.id,
      before: { createdAt: page1Oldest.createdAt, id: page1Oldest.id },
      limit: 2,
    });
    expect(page2.hasEarlier).toBe(true);
    expect(page2.messages.map((m) => m.body)).toEqual(['<p>m2</p>', '<p>m3</p>']);

    // Page 3: the final remainder — hasEarlier flips false.
    const [page2Oldest] = page2.messages;
    if (page2Oldest === undefined) throw new Error('expected a first message on page 2');
    const page3 = await conversationsRepository.listMessagesPage({
      relationshipId: relationship.id,
      before: { createdAt: page2Oldest.createdAt, id: page2Oldest.id },
      limit: 2,
    });
    expect(page3.hasEarlier).toBe(false);
    expect(page3.messages.map((m) => m.body)).toEqual(['<p>m1</p>']);
  });

  it('breaks same-timestamp ties by id — no duplicates or gaps across pages', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const at = new Date('2026-06-02T00:00:00Z');
    const idA = '00000000-0000-4000-8000-00000000000a';
    const idB = '00000000-0000-4000-8000-00000000000b';
    const idC = '00000000-0000-4000-8000-00000000000c';
    for (const id of [idA, idB, idC]) {
      await seedMessage({
        relationshipId: relationship.id,
        senderUserId: sender.id,
        body: `<p>${id}</p>`,
        createdAt: at,
        id,
      });
    }

    // Internal order is (created_at DESC, id DESC) → c, b, a. Page of 2 →
    // [c, b] → chronological [b, c].
    const page1 = await conversationsRepository.listMessagesPage({
      relationshipId: relationship.id,
      limit: 2,
    });
    expect(page1.messages.map((m) => m.id)).toEqual([idB, idC]);
    expect(page1.hasEarlier).toBe(true);

    // Cursor on (same timestamp, idB) → strict tuple < returns only idA.
    const [oldest] = page1.messages;
    if (oldest === undefined) throw new Error('expected a first message on page 1');
    const page2 = await conversationsRepository.listMessagesPage({
      relationshipId: relationship.id,
      before: { createdAt: oldest.createdAt, id: oldest.id },
      limit: 2,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([idA]);
    expect(page2.hasEarlier).toBe(false);
  });

  it('excludes soft-deleted messages from pages and from hasEarlier', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const sender = await userFactory();
    const base = Date.parse('2026-06-03T00:00:00Z');
    const live1 = await seedMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>live-1</p>',
      createdAt: new Date(base),
    });
    await seedMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 1000),
      deletedAt: new Date(),
    });
    const live2 = await seedMessage({
      relationshipId: relationship.id,
      senderUserId: sender.id,
      body: '<p>live-2</p>',
      createdAt: new Date(base + 2000),
    });

    // 2 live + 1 deleted with limit 2: the deleted row must not appear AND
    // must not count as an "earlier" row.
    const page = await conversationsRepository.listMessagesPage({
      relationshipId: relationship.id,
      limit: 2,
    });
    expect(page.messages.map((m) => m.id)).toEqual([live1.id, live2.id]);
    expect(page.hasEarlier).toBe(false);
  });
});

describe('conversationsRepository.listThreadSummaries', () => {
  it('returns [] for empty input and the zero shape for an empty thread', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();

    expect(
      await conversationsRepository.listThreadSummaries({
        relationshipIds: [],
        viewerUserId: viewer.id,
      })
    ).toEqual([]);

    const summaries = await conversationsRepository.listThreadSummaries({
      relationshipIds: [relationship.id],
      viewerUserId: viewer.id,
    });
    expect(summaries).toEqual([
      {
        relationshipId: relationship.id,
        latestMessage: null,
        latestInboundActivityAt: null,
        fileCount: 0,
        lastReadAt: null,
      },
    ]);
  });

  it('batches N threads in input order: latest any-sender message, inbound excludes viewer, files count toward inbound', async () => {
    const viewer = await userFactory();
    const other = await userFactory();
    const a = await requestExpertRelationshipFactory();
    const b = await requestExpertRelationshipFactory();
    const base = Date.parse('2026-06-04T00:00:00Z');

    // Thread A: other m1 → viewer m2 (newest message) → other FILE (newest
    // inbound overall) — and the viewer marked read in between.
    await seedMessage({
      relationshipId: a.relationship.id,
      senderUserId: other.id,
      body: '<p>a-inbound</p>',
      createdAt: new Date(base),
    });
    const aViewerMsg = await seedMessage({
      relationshipId: a.relationship.id,
      senderUserId: viewer.id,
      body: '<p>a-own-latest</p>',
      createdAt: new Date(base + 1000),
    });
    const aInboundFile = await seedFile({
      relationshipId: a.relationship.id,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 2000),
    });
    const aReadAt = new Date(base + 500);
    await conversationsRepository.markThreadRead({
      relationshipId: a.relationship.id,
      userId: viewer.id,
      at: aReadAt,
    });

    // Thread B: file-only — other's file at base, viewer's NEWER file at
    // base+1000 (own activity must not count as inbound; both count for size).
    const bInboundFile = await seedFile({
      relationshipId: b.relationship.id,
      uploadedByUserId: other.id,
      createdAt: new Date(base),
    });
    await seedFile({
      relationshipId: b.relationship.id,
      uploadedByUserId: viewer.id,
      createdAt: new Date(base + 1000),
    });

    const summaries = await conversationsRepository.listThreadSummaries({
      relationshipIds: [a.relationship.id, b.relationship.id],
      viewerUserId: viewer.id,
    });
    expect(summaries.map((s) => s.relationshipId)).toEqual([a.relationship.id, b.relationship.id]);
    const [summaryA, summaryB] = summaries;
    if (summaryA === undefined || summaryB === undefined) {
      throw new Error('expected one summary per input id');
    }

    // A: preview = newest message ANY sender (the viewer's own); inbound =
    // the other party's newer FILE (max across message/file legs).
    expect(summaryA.latestMessage?.id).toBe(aViewerMsg.id);
    expect(summaryA.latestMessage?.senderUserId).toBe(viewer.id);
    expect(summaryA.latestInboundActivityAt?.getTime()).toBe(aInboundFile.createdAt.getTime());
    expect(summaryA.fileCount).toBe(1);
    expect(summaryA.lastReadAt?.getTime()).toBe(aReadAt.getTime());

    // B: no messages at all; inbound = the OTHER party's older file (the
    // viewer's newer upload is excluded); fileCount counts both.
    expect(summaryB.latestMessage).toBeNull();
    expect(summaryB.latestInboundActivityAt?.getTime()).toBe(bInboundFile.createdAt.getTime());
    expect(summaryB.fileCount).toBe(2);
    expect(summaryB.lastReadAt).toBeNull();
  });

  it('excludes soft-deleted messages, files, and read states from every leg', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const other = await userFactory();
    const base = Date.parse('2026-06-05T00:00:00Z');

    const liveMsg = await seedMessage({
      relationshipId: relationship.id,
      senderUserId: other.id,
      body: '<p>live</p>',
      createdAt: new Date(base),
    });
    // Newer but soft-deleted message/file must influence NOTHING.
    await seedMessage({
      relationshipId: relationship.id,
      senderUserId: other.id,
      body: '<p>deleted</p>',
      createdAt: new Date(base + 1000),
      deletedAt: new Date(),
    });
    await seedFile({
      relationshipId: relationship.id,
      uploadedByUserId: other.id,
      createdAt: new Date(base + 2000),
      deletedAt: new Date(),
    });
    // Soft-deleted read state for the viewer → lastReadAt null.
    await db.insert(conversationReadStates).values({
      relationshipId: relationship.id,
      userId: viewer.id,
      lastReadAt: new Date(base),
      deletedAt: new Date(),
    });
    // ANOTHER user's live read state must not leak into the viewer's summary.
    await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: other.id,
      at: new Date(base + 3000),
    });

    const summaries = await conversationsRepository.listThreadSummaries({
      relationshipIds: [relationship.id],
      viewerUserId: viewer.id,
    });
    const [summary] = summaries;
    if (summary === undefined) throw new Error('expected one summary');

    expect(summary.latestMessage?.id).toBe(liveMsg.id);
    expect(summary.latestInboundActivityAt?.getTime()).toBe(liveMsg.createdAt.getTime());
    expect(summary.fileCount).toBe(0);
    expect(summary.lastReadAt).toBeNull();
  });
});

describe('conversationsRepository.markThreadRead', () => {
  it('inserts a fresh watermark for a first mark', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const at = new Date('2026-06-06T00:00:00Z');

    const row = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at,
    });

    expect(row.relationshipId).toBe(relationship.id);
    expect(row.userId).toBe(viewer.id);
    expect(row.lastReadAt.getTime()).toBe(at.getTime());
    expect(row.deletedAt).toBeNull();
  });

  it('advances on a newer mark and never regresses on an older one (GREATEST)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    const t1 = new Date('2026-06-06T10:00:00Z');
    const t2 = new Date('2026-06-06T11:00:00Z');

    const first = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at: t1,
    });
    // Newer mark → conflict path on the partial unique index updates the SAME
    // row forward.
    const advanced = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at: t2,
    });
    expect(advanced.id).toBe(first.id);
    expect(advanced.lastReadAt.getTime()).toBe(t2.getTime());

    // Older (out-of-order/concurrent) mark → watermark must NOT move back.
    const noRegress = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at: t1,
    });
    expect(noRegress.id).toBe(first.id);
    expect(noRegress.lastReadAt.getTime()).toBe(t2.getTime());

    // Still exactly one live row for (relationship, user).
    const rows = await db
      .select()
      .from(conversationReadStates)
      .where(
        and(
          eq(conversationReadStates.relationshipId, relationship.id),
          eq(conversationReadStates.userId, viewer.id)
        )
      );
    expect(rows).toHaveLength(1);
  });

  it('re-creates a fresh row after soft delete (partial unique frees the slot)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();

    const first = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at: new Date('2026-06-07T00:00:00Z'),
    });
    await db
      .update(conversationReadStates)
      .set({ deletedAt: new Date() })
      .where(eq(conversationReadStates.id, first.id));

    // The soft-deleted row no longer occupies the (partial) unique slot — the
    // next mark INSERTS a new live row instead of silently failing.
    const at = new Date('2026-06-07T01:00:00Z');
    const second = await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.lastReadAt.getTime()).toBe(at.getTime());
    expect(second.deletedAt).toBeNull();
  });

  it('rejects a second LIVE row at the DB level (partial unique index)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const viewer = await userFactory();
    await conversationsRepository.markThreadRead({
      relationshipId: relationship.id,
      userId: viewer.id,
      at: new Date('2026-06-08T00:00:00Z'),
    });

    // A raw second live insert hits `conversation_read_state_unique_idx`.
    // Wrapped in db.transaction() so the violation aborts a SAVEPOINT, not the
    // per-test wrapping transaction — the row-count assertion below still
    // needs a usable transaction.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(conversationReadStates).values({
          relationshipId: relationship.id,
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
          eq(conversationReadStates.relationshipId, relationship.id),
          eq(conversationReadStates.userId, viewer.id)
        )
      );
    expect(rows).toHaveLength(1);
  });

  it('throws on a non-existent relationship id (FK)', async () => {
    const viewer = await userFactory();
    await expect(
      conversationsRepository.markThreadRead({
        relationshipId: randomUUID(),
        userId: viewer.id,
        at: new Date(),
      })
    ).rejects.toThrow();
  });
});
