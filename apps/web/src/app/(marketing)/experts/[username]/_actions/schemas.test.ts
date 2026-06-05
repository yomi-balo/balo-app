import { describe, it, expect } from 'vitest';
import { projectRequestInputSchema } from './schemas';

const UUID = 'a0000000-0000-4000-8000-000000000001';

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expertProfileId: UUID,
    title: 'Lead routing rebuild',
    description: 'Rebuild lead routing in Flow with proper assignment rules.',
    ...overrides,
  };
}

describe('projectRequestInputSchema', () => {
  it('accepts a valid minimal input and defaults source to manual', () => {
    const result = projectRequestInputSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('manual');
    }
  });

  it('trims title and description', () => {
    const result = projectRequestInputSchema.safeParse(
      baseInput({ title: '  Padded title  ', description: '  Padded description here  ' })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Padded title');
      expect(result.data.description).toBe('Padded description here');
    }
  });

  describe('title', () => {
    it('rejects a title shorter than 3 characters', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ title: 'ab' }));
      expect(result.success).toBe(false);
    });

    it('rejects a title longer than 200 characters', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ title: 'a'.repeat(201) }));
      expect(result.success).toBe(false);
    });

    it('accepts a 3-character title', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ title: 'abc' }));
      expect(result.success).toBe(true);
    });
  });

  describe('description', () => {
    it('rejects a description shorter than 10 characters', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ description: 'too short' }));
      expect(result.success).toBe(false);
    });

    it('rejects a description longer than 5000 characters', () => {
      const result = projectRequestInputSchema.safeParse(
        baseInput({ description: 'a'.repeat(5001) })
      );
      expect(result.success).toBe(false);
    });
  });

  describe('expertProfileId', () => {
    it('rejects a non-uuid expertProfileId', () => {
      const result = projectRequestInputSchema.safeParse(
        baseInput({ expertProfileId: 'not-a-uuid' })
      );
      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    it('accepts null optional fields', () => {
      const result = projectRequestInputSchema.safeParse(
        baseInput({ focusArea: null, budget: null, timeline: null })
      );
      expect(result.success).toBe(true);
    });

    it('accepts provided optional fields', () => {
      const result = projectRequestInputSchema.safeParse(
        baseInput({ focusArea: 'Sales Cloud', budget: 'A$2–5k', timeline: 'ASAP' })
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.focusArea).toBe('Sales Cloud');
        expect(result.data.budget).toBe('A$2–5k');
        expect(result.data.timeline).toBe('ASAP');
      }
    });

    it('rejects a focusArea longer than 100 characters', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ focusArea: 'a'.repeat(101) }));
      expect(result.success).toBe(false);
    });
  });

  describe('source', () => {
    it('accepts manual, ai, and quickstart', () => {
      for (const source of ['manual', 'ai', 'quickstart'] as const) {
        const result = projectRequestInputSchema.safeParse(baseInput({ source }));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.source).toBe(source);
        }
      }
    });

    it('rejects an unknown source', () => {
      const result = projectRequestInputSchema.safeParse(baseInput({ source: 'imported' }));
      expect(result.success).toBe(false);
    });
  });
});
