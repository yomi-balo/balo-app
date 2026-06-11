import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { proposalFactory, userFactory } from '../test/factories';
import { proposalDocumentsRepository } from './proposal-documents';

interface DocArgs {
  proposalId: string;
  uploadedByUserId: string;
  r2Key?: string;
  kind?: 'terms' | 'ref';
}

async function seedDoc(
  args: DocArgs
): Promise<ReturnType<typeof proposalDocumentsRepository.addDocument>> {
  return proposalDocumentsRepository.addDocument({
    proposalId: args.proposalId,
    uploadedByUserId: args.uploadedByUserId,
    kind: args.kind ?? 'ref',
    r2Key: args.r2Key ?? `proposals/${randomUUID()}/file.pdf`,
    fileName: 'file.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  });
}

describe('proposalDocumentsRepository.addDocument', () => {
  it('inserts with kind, uploader, and r2 fields', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();

    const doc = await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      kind: 'terms',
      r2Key: 'proposals/p1/terms.pdf',
    });

    expect(doc.proposalId).toBe(proposal.id);
    expect(doc.uploadedByUserId).toBe(uploader.id);
    expect(doc.kind).toBe('terms');
    expect(doc.r2Key).toBe('proposals/p1/terms.pdf');
    expect(doc.fileName).toBe('file.pdf');
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.sizeBytes).toBe(1024);
    expect(doc.deletedAt).toBeNull();
  });

  it('rejects a duplicate r2_key (23505 — non-partial unique)', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();
    await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      r2Key: 'proposals/dup.pdf',
    });

    await expect(
      seedDoc({
        proposalId: proposal.id,
        uploadedByUserId: uploader.id,
        r2Key: 'proposals/dup.pdf',
      })
    ).rejects.toThrow();
  });

  it('still rejects a duplicate r2_key after the first row is soft-deleted (deliberate non-partial unique)', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();
    const first = await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      r2Key: 'proposals/reused.pdf',
    });

    await proposalDocumentsRepository.softDelete(first.id);

    // The unique index is NON-partial, so the soft-deleted row still occupies the key.
    await expect(
      seedDoc({
        proposalId: proposal.id,
        uploadedByUserId: uploader.id,
        r2Key: 'proposals/reused.pdf',
      })
    ).rejects.toThrow();
  });

  it('throws for an unknown proposalId (FK cascade target) and an unknown uploader (FK restrict target)', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();

    await expect(
      seedDoc({ proposalId: randomUUID(), uploadedByUserId: uploader.id })
    ).rejects.toThrow();
    await expect(
      seedDoc({ proposalId: proposal.id, uploadedByUserId: randomUUID() })
    ).rejects.toThrow();
  });
});

describe('proposalDocumentsRepository.listByProposal', () => {
  it('returns live docs oldest-first, optionally filtered by kind, excluding soft-deleted', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();

    const terms = await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      kind: 'terms',
    });
    const ref1 = await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      kind: 'ref',
    });
    const ref2 = await seedDoc({
      proposalId: proposal.id,
      uploadedByUserId: uploader.id,
      kind: 'ref',
    });

    const all = await proposalDocumentsRepository.listByProposal(proposal.id);
    expect(all.map((d) => d.id)).toEqual([terms.id, ref1.id, ref2.id]); // oldest-first

    const onlyRef = await proposalDocumentsRepository.listByProposal(proposal.id, 'ref');
    expect(onlyRef.map((d) => d.id)).toEqual([ref1.id, ref2.id]);

    const onlyTerms = await proposalDocumentsRepository.listByProposal(proposal.id, 'terms');
    expect(onlyTerms.map((d) => d.id)).toEqual([terms.id]);

    await proposalDocumentsRepository.softDelete(ref1.id);
    const afterDelete = await proposalDocumentsRepository.listByProposal(proposal.id);
    expect(afterDelete.map((d) => d.id)).toEqual([terms.id, ref2.id]);
  });
});

describe('proposalDocumentsRepository.softDelete', () => {
  it('removes the doc from listByProposal and is idempotent (re-delete → undefined)', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();
    const doc = await seedDoc({ proposalId: proposal.id, uploadedByUserId: uploader.id });

    const removed = await proposalDocumentsRepository.softDelete(doc.id);
    expect(removed?.id).toBe(doc.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);
    expect(await proposalDocumentsRepository.listByProposal(proposal.id)).toHaveLength(0);

    // Idempotent — already deleted → undefined.
    expect(await proposalDocumentsRepository.softDelete(doc.id)).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    expect(await proposalDocumentsRepository.softDelete(randomUUID())).toBeUndefined();
  });
});
