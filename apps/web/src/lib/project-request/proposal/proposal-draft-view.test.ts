import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockFindLive } = vi.hoisted(() => ({ mockFindLive: vi.fn() }));
vi.mock('@balo/db', () => ({
  proposalDraftGenerationsRepository: {
    findLiveByRelationship: (...a: unknown[]) => mockFindLive(...a),
  },
}));

import type { ProposalDraftGeneration } from '@balo/db';
import { DRAFT_DEADLINE_MS, PROPOSAL_DRAFT_MAX_TITLE } from '@balo/shared/project-requests';
import { log } from '@/lib/logging';
import {
  loadProposalDraftGenerationView,
  toProposalDraftGenerationView,
  toProposalDraftPatch,
} from './proposal-draft-view';

const NOW = new Date('2026-01-01T12:00:00.000Z').getTime();

const MILESTONE = {
  title: '  Discovery  ',
  descriptionHtml: '<p>Map the process.</p>',
  acceptanceCriteria: '  Sign-off on the map.  ',
};

const OUTPUT = {
  overviewHtml: '<p>Hi Northwind, here is the plan.</p>',
  milestones: [MILESTONE, { ...MILESTONE, title: 'Build' }],
};

function row(overrides: Partial<ProposalDraftGeneration> = {}): ProposalDraftGeneration {
  return {
    id: 'gen-1',
    relationshipId: 'rel-1',
    status: 'pending',
    output: null,
    failureReason: null,
    createdAt: new Date(NOW - 1_000),
    ...overrides,
  } as ProposalDraftGeneration;
}

describe('toProposalDraftPatch', () => {
  it('trims titles and acceptance criteria and keeps sanitised html', () => {
    const patch = toProposalDraftPatch(OUTPUT);
    expect(patch?.overviewHtml).toBe('<p>Hi Northwind, here is the plan.</p>');
    expect(patch?.milestones[0]).toEqual({
      title: 'Discovery',
      descriptionHtml: '<p>Map the process.</p>',
      acceptanceCriteria: 'Sign-off on the map.',
    });
  });

  it('keeps a tag in the overview that the milestone description loses (the sanitiser split)', () => {
    const patch = toProposalDraftPatch({
      overviewHtml: '<blockquote>Quoted</blockquote><p>Body</p>',
      milestones: [
        { ...MILESTONE, descriptionHtml: '<blockquote>Quoted</blockquote><p>Body</p>' },
        MILESTONE,
      ],
    });
    expect(patch?.overviewHtml).toContain('<blockquote>');
    expect(patch?.milestones[0]?.descriptionHtml).not.toContain('<blockquote>');
    expect(patch?.milestones[0]?.descriptionHtml).toContain('Quoted');
  });

  it('unwraps links to plain text in the overview and in a milestone description', () => {
    const patch = toProposalDraftPatch({
      overviewHtml: '<p>See <a href="https://example.com/x" target="_blank">our plan</a> now.</p>',
      milestones: [
        {
          ...MILESTONE,
          descriptionHtml: '<p>Read <a href="mailto:a@b.co">the notes</a> first.</p>',
        },
        MILESTONE,
      ],
    });
    expect(patch?.overviewHtml).toBe('<p>See our plan now.</p>');
    expect(patch?.milestones[0]?.descriptionHtml).toBe('<p>Read the notes first.</p>');
  });

  it('keeps list and emphasis markup while unwrapping a link', () => {
    const patch = toProposalDraftPatch({
      overviewHtml: '<ul><li><strong>One</strong> <a href="https://e.co">two</a></li></ul>',
      milestones: [MILESTONE, MILESTONE],
    });
    expect(patch?.overviewHtml).toBe('<ul><li><strong>One</strong> two</li></ul>');
  });

  it('narrows a milestone description to the tags the light editor renders', () => {
    const patch = toProposalDraftPatch({
      overviewHtml: '<h2>Plan</h2><ol><li>One</li></ol>',
      milestones: [
        {
          ...MILESTONE,
          descriptionHtml:
            '<h2>Scope</h2><h3>Detail</h3><ol><li><b>First</b></li><li><i>Second</i></li></ol>' +
            '<p>Line<br>break with <strong>bold</strong>, <em>em</em> and ' +
            '<a href="https://e.co">a link</a>.</p><ul><li>Kept</li></ul>',
        },
        MILESTONE,
      ],
    });
    expect(patch?.overviewHtml).toBe('<h2>Plan</h2><ol><li>One</li></ol>');
    expect(patch?.milestones[0]?.descriptionHtml).toBe(
      '<p>Scope</p><p>Detail</p><ul><li><strong>First</strong></li><li><em>Second</em></li></ul>' +
        '<p>Line<br />break with <strong>bold</strong>, <em>em</em> and a link.</p>' +
        '<ul><li>Kept</li></ul>'
    );
  });

  it('maps headings and blockquotes to paragraphs so their text stays separate', () => {
    const patch = toProposalDraftPatch({
      ...OUTPUT,
      milestones: [
        { ...MILESTONE, descriptionHtml: '<h1>Title</h1><blockquote>Quoted</blockquote>' },
        MILESTONE,
      ],
    });
    expect(patch?.milestones[0]?.descriptionHtml).toBe('<p>Title</p><p>Quoted</p>');
  });

  it('maps div, h5 and h6 to paragraphs', () => {
    const patch = toProposalDraftPatch({
      ...OUTPUT,
      milestones: [
        { ...MILESTONE, descriptionHtml: '<div>A</div><h5>Five</h5><h6>Six</h6>' },
        MILESTONE,
      ],
    });
    expect(patch?.milestones[0]?.descriptionHtml).toBe('<p>A</p><p>Five</p><p>Six</p>');
  });

  it('leaves no empty paragraph behind a block wrapped around a paragraph', () => {
    const patch = toProposalDraftPatch({
      ...OUTPUT,
      milestones: [
        {
          ...MILESTONE,
          descriptionHtml: '<blockquote><p>Quoted</p></blockquote><div><p>A</p></div>',
        },
        MILESTONE,
      ],
    });
    expect(patch?.milestones[0]?.descriptionHtml).toBe('<p>Quoted</p><p>A</p>');
  });

  it('strips scripts from both the overview and the milestone descriptions', () => {
    const patch = toProposalDraftPatch({
      overviewHtml: '<p>ok</p><script>alert(1)</script>',
      milestones: [
        { ...MILESTONE, descriptionHtml: '<p>fine</p><script>alert(2)</script>' },
        MILESTONE,
      ],
    });
    expect(patch?.overviewHtml).not.toContain('script');
    expect(patch?.overviewHtml).not.toContain('alert');
    expect(patch?.milestones[0]?.descriptionHtml).not.toContain('script');
    expect(patch?.milestones[0]?.descriptionHtml).not.toContain('alert');
  });

  it('returns null when the overview has no text once sanitised', () => {
    expect(
      toProposalDraftPatch({ ...OUTPUT, overviewHtml: '<script>alert(1)</script>' })
    ).toBeNull();
  });

  it('returns null for fewer than two or more than five milestones', () => {
    expect(toProposalDraftPatch({ ...OUTPUT, milestones: [MILESTONE] })).toBeNull();
    expect(
      toProposalDraftPatch({ ...OUTPUT, milestones: Array.from({ length: 6 }, () => MILESTONE) })
    ).toBeNull();
  });

  it('returns null for an over-long title and for non-object output', () => {
    expect(
      toProposalDraftPatch({
        ...OUTPUT,
        milestones: [{ ...MILESTONE, title: 'x'.repeat(PROPOSAL_DRAFT_MAX_TITLE + 1) }, MILESTONE],
      })
    ).toBeNull();
    expect(toProposalDraftPatch(null)).toBeNull();
    expect(toProposalDraftPatch('nope')).toBeNull();
  });
});

describe('toProposalDraftGenerationView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is none when there is no row', () => {
    expect(toProposalDraftGenerationView(undefined, NOW)).toEqual({ status: 'none' });
  });

  it('is pending while the row is within the deadline', () => {
    expect(toProposalDraftGenerationView(row(), NOW)).toEqual({
      status: 'pending',
      generationId: 'gen-1',
    });
  });

  it('is pending exactly at the deadline and failed once it is exceeded', () => {
    const atDeadline = row({ createdAt: new Date(NOW - DRAFT_DEADLINE_MS) });
    const pastDeadline = row({ createdAt: new Date(NOW - DRAFT_DEADLINE_MS - 1) });
    expect(toProposalDraftGenerationView(atDeadline, NOW).status).toBe('pending');
    expect(toProposalDraftGenerationView(pastDeadline, NOW)).toEqual({ status: 'failed' });
  });

  it('is failed for a failed row', () => {
    expect(
      toProposalDraftGenerationView(row({ status: 'failed', failureReason: 'unknown' }), NOW)
    ).toEqual({ status: 'failed' });
  });

  it('carries the sanitised patch for a succeeded row', () => {
    const view = toProposalDraftGenerationView(row({ status: 'succeeded', output: OUTPUT }), NOW);
    expect(view.status).toBe('succeeded');
    if (view.status === 'succeeded') {
      expect(view.generationId).toBe('gen-1');
      expect(view.patch.milestones).toHaveLength(2);
    }
  });

  it('logs and reads as failed when a succeeded row fails the shape or floor check', () => {
    const view = toProposalDraftGenerationView(
      row({ status: 'succeeded', output: { overviewHtml: '', milestones: [] } }),
      NOW
    );
    expect(view).toEqual({ status: 'failed' });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('failed its shape or floor check'),
      { generationId: 'gen-1', relationshipId: 'rel-1' }
    );
  });
});

describe('loadProposalDraftGenerationView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the live row to its view', async () => {
    mockFindLive.mockResolvedValue(row({ createdAt: new Date() }));
    const view = await loadProposalDraftGenerationView('rel-1');
    expect(mockFindLive).toHaveBeenCalledWith('rel-1');
    expect(view.status).toBe('pending');
  });

  it('is none when the relationship has no generation', async () => {
    mockFindLive.mockResolvedValue(undefined);
    expect(await loadProposalDraftGenerationView('rel-1')).toEqual({ status: 'none' });
  });

  it('logs and reads as skipped, never throwing, when the lookup fails', async () => {
    mockFindLive.mockRejectedValue(new Error('db down'));
    expect(await loadProposalDraftGenerationView('rel-1')).toEqual({ status: 'skipped' });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load'),
      expect.objectContaining({ relationshipId: 'rel-1', error: 'db down' })
    );
  });
});
