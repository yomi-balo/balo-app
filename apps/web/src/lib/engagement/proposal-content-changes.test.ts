import { describe, it, expect } from 'vitest';
import {
  deriveProposalChanges,
  diffProposalContent,
  summarizeProposalChanges,
  type MilestoneContent,
  type ProposalEditRow,
} from './proposal-content-changes';

const CURRENT: MilestoneContent = {
  title: 'Build',
  descriptionHtml: '<p>New text</p>',
  acceptanceCriteria: 'Signed off',
};

const direct = (before: ProposalEditRow['before']): ProposalEditRow => ({ kind: 'direct', before });
const approved: ProposalEditRow = { kind: 'change_order', before: {} };

describe('diffProposalContent', () => {
  it('reports only the fields that differ in plain text', () => {
    const changes = diffProposalContent(CURRENT, {
      title: 'Build v2',
      descriptionHtml: '<p>New text</p>',
      acceptanceCriteria: undefined,
    });
    expect(changes).toEqual([
      { field: 'title', label: 'Title', before: 'Build', after: 'Build v2' },
    ]);
  });

  it('treats a cleared field as a change to empty', () => {
    const [change] = diffProposalContent(CURRENT, { acceptanceCriteria: null });
    expect(change).toMatchObject({ field: 'acceptance_criteria', before: 'Signed off', after: '' });
  });

  it('is empty when nothing differs', () => {
    expect(diffProposalContent(CURRENT, { title: 'Build' })).toEqual([]);
  });
});

describe('deriveProposalChanges', () => {
  it('uses the first direct edit as the before value of each field', () => {
    const changes = deriveProposalChanges(CURRENT, [
      direct({ title: 'Original', descriptionHtml: '<p>Old text</p>' }),
      direct({ title: 'Middle' }),
    ]);
    expect(changes).toEqual([
      { field: 'title', label: 'Title', before: 'Original', after: 'Build' },
      { field: 'description', label: 'Description', before: 'Old text', after: 'New text' },
    ]);
  });

  it('resets the baseline at a change-order approval', () => {
    const changes = deriveProposalChanges(CURRENT, [
      direct({ title: 'Original' }),
      approved,
      direct({ acceptanceCriteria: 'Reviewed' }),
    ]);
    expect(changes.map((c) => c.field)).toEqual(['acceptance_criteria']);
  });

  it('drops a field edited back to its original value', () => {
    expect(deriveProposalChanges(CURRENT, [direct({ title: 'Build' })])).toEqual([]);
  });

  it('is empty for no rows', () => {
    expect(deriveProposalChanges(CURRENT, [])).toEqual([]);
  });
});

describe('summarizeProposalChanges', () => {
  it('joins fields and shows an empty side as none', () => {
    expect(
      summarizeProposalChanges([
        { field: 'title', label: 'Title', before: 'A', after: 'B' },
        { field: 'acceptance_criteria', label: 'Done when', before: '', after: 'C' },
      ])
    ).toBe('Title: “A” → “B”; Done when: none → “C”');
  });

  it('cuts each side to 60 characters', () => {
    const summary = summarizeProposalChanges([
      { field: 'title', label: 'Title', before: 'x'.repeat(80), after: 'y' },
    ]);
    expect(summary).toBe(`Title: “${'x'.repeat(60)}…” → “y”`);
  });

  it('caps the whole summary', () => {
    const many = Array.from({ length: 3 }, () => ({
      field: 'title' as const,
      label: 'Title' as const,
      before: 'x'.repeat(60),
      after: 'y'.repeat(60),
    }));
    expect(summarizeProposalChanges(many, 100)).toHaveLength(100);
  });

  it('is empty for no changes', () => {
    expect(summarizeProposalChanges([])).toBe('');
  });
});
