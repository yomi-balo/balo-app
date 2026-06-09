import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { conversationMessages, conversationFiles } from '../schema';
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
