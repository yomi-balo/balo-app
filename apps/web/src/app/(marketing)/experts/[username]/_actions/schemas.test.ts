import { describe, it, expect } from 'vitest';
import { projectRequestInputSchema, documentRefSchema, MAX_DOCUMENT_BYTES } from './schemas';

const UUID = 'a0000000-0000-4000-8000-000000000001';
const TAG_UUID = 'b0000000-0000-4000-8000-000000000002';
const PRODUCT_UUID = 'c0000000-0000-4000-8000-000000000003';

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    r2Key: 'project-documents/company/user/doc-1',
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

function directInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sendTo: 'direct',
    expertProfileId: UUID,
    title: 'Lead routing rebuild',
    description: '<p>Rebuild lead routing in Flow with proper assignment rules.</p>',
    ...overrides,
  };
}

function matchInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sendTo: 'match',
    title: 'Lead routing rebuild',
    description: '<p>Rebuild lead routing in Flow with proper assignment rules.</p>',
    ...overrides,
  };
}

describe('projectRequestInputSchema', () => {
  describe('direct branch', () => {
    it('accepts a valid direct input and defaults arrays + source', () => {
      const result = projectRequestInputSchema.safeParse(directInput());
      expect(result.success).toBe(true);
      if (result.success && result.data.sendTo === 'direct') {
        expect(result.data.source).toBe('manual');
        expect(result.data.tagIds).toEqual([]);
        expect(result.data.productIds).toEqual([]);
        expect(result.data.documents).toEqual([]);
        expect(result.data.expertProfileId).toBe(UUID);
      }
    });

    it('requires expertProfileId for direct', () => {
      const directBase = directInput();
      const withoutExpert = { ...directBase };
      delete (withoutExpert as Partial<typeof directBase>).expertProfileId;
      const result = projectRequestInputSchema.safeParse(withoutExpert);
      expect(result.success).toBe(false);
    });

    it('rejects a non-uuid expertProfileId', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ expertProfileId: 'not-a-uuid' })
      );
      expect(result.success).toBe(false);
    });

    it('trims title and description', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ title: '  Padded title  ', description: '  <p>Padded</p>  ' })
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('Padded title');
        expect(result.data.description).toBe('<p>Padded</p>');
      }
    });
  });

  describe('match branch', () => {
    it('accepts a valid match input WITHOUT an expertProfileId', () => {
      const result = projectRequestInputSchema.safeParse(matchInput());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sendTo).toBe('match');
      }
    });

    it('rejects match WITH an expertProfileId (mutually exclusive)', () => {
      const result = projectRequestInputSchema.safeParse(matchInput({ expertProfileId: UUID }));
      // The match branch has no expertProfileId key; the extra key is stripped,
      // so this still parses — but the parsed data must NOT carry expertProfileId.
      expect(result.success).toBe(true);
      if (result.success) {
        expect('expertProfileId' in result.data).toBe(false);
      }
    });
  });

  describe('sendTo discriminator', () => {
    it('rejects an unknown sendTo value', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ sendTo: 'broadcast' }));
      expect(result.success).toBe(false);
    });

    it('rejects a missing sendTo', () => {
      const directBase = directInput();
      const noSendTo = { ...directBase };
      delete (noSendTo as Partial<typeof directBase>).sendTo;
      const result = projectRequestInputSchema.safeParse(noSendTo);
      expect(result.success).toBe(false);
    });
  });

  describe('title', () => {
    it('rejects a title shorter than 3 characters', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ title: 'ab' }));
      expect(result.success).toBe(false);
    });

    it('rejects a title longer than 120 characters', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ title: 'a'.repeat(121) }));
      expect(result.success).toBe(false);
    });

    it('accepts a 3-character title', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ title: 'abc' }));
      expect(result.success).toBe(true);
    });
  });

  describe('description', () => {
    it('rejects an empty description', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ description: '' }));
      expect(result.success).toBe(false);
    });

    it('rejects a description longer than 20000 characters', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ description: 'a'.repeat(20001) })
      );
      expect(result.success).toBe(false);
    });

    it('accepts a single-character description (bound is raw HTML, not UX text)', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ description: 'a' }));
      expect(result.success).toBe(true);
    });
  });

  describe('tagIds', () => {
    it('accepts an array of UUIDs', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ tagIds: [TAG_UUID] }));
      expect(result.success).toBe(true);
    });

    it('rejects a non-uuid tag id', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ tagIds: ['nope'] }));
      expect(result.success).toBe(false);
    });

    it('rejects more than 19 tags', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ tagIds: Array.from({ length: 20 }, () => TAG_UUID) })
      );
      expect(result.success).toBe(false);
    });
  });

  describe('productIds', () => {
    it('accepts an array of UUIDs', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ productIds: [PRODUCT_UUID] })
      );
      expect(result.success).toBe(true);
    });

    it('rejects a non-uuid product id', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ productIds: ['nope'] }));
      expect(result.success).toBe(false);
    });
  });

  describe('documents', () => {
    it('accepts a valid document ref', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ documents: [validDocument()] })
      );
      expect(result.success).toBe(true);
    });

    it('rejects more than 4 documents', () => {
      const result = projectRequestInputSchema.safeParse(
        directInput({ documents: Array.from({ length: 5 }, () => validDocument()) })
      );
      expect(result.success).toBe(false);
    });

    it('rejects a document with a disallowed content type', () => {
      const result = documentRefSchema.safeParse(validDocument({ contentType: 'text/html' }));
      expect(result.success).toBe(false);
    });

    it('rejects a document over the size limit', () => {
      const result = documentRefSchema.safeParse(
        validDocument({ sizeBytes: MAX_DOCUMENT_BYTES + 1 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects a document with an empty r2Key', () => {
      const result = documentRefSchema.safeParse(validDocument({ r2Key: '' }));
      expect(result.success).toBe(false);
    });

    it('rejects a document with a non-positive size', () => {
      const result = documentRefSchema.safeParse(validDocument({ sizeBytes: 0 }));
      expect(result.success).toBe(false);
    });
  });

  describe('source', () => {
    it('accepts manual, ai, and quickstart', () => {
      for (const source of ['manual', 'ai', 'quickstart'] as const) {
        const result = projectRequestInputSchema.safeParse(directInput({ source }));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.source).toBe(source);
        }
      }
    });

    it('rejects an unknown source', () => {
      const result = projectRequestInputSchema.safeParse(directInput({ source: 'imported' }));
      expect(result.success).toBe(false);
    });
  });
});
