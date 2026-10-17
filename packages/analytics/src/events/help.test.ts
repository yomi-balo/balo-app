import { describe, it, expect } from 'vitest';
import {
  HELP_EVENTS,
  HELP_AUDIENCES,
  HELP_ARTICLE_SOURCES,
  HELP_FEEDBACK_COMMENT_MAX,
} from './help';

describe('HELP_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(HELP_EVENTS)).toEqual([
      'INDEX_VIEWED',
      'AUDIENCE_SWITCHED',
      'ARTICLE_VIEWED',
      'SECTION_JUMPED',
      'FEEDBACK_SUBMITTED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(HELP_EVENTS.INDEX_VIEWED).toBe('help_index_viewed');
    expect(HELP_EVENTS.AUDIENCE_SWITCHED).toBe('help_audience_switched');
    expect(HELP_EVENTS.ARTICLE_VIEWED).toBe('help_article_viewed');
    expect(HELP_EVENTS.SECTION_JUMPED).toBe('help_section_jumped');
    expect(HELP_EVENTS.FEEDBACK_SUBMITTED).toBe('help_feedback_submitted');
  });

  it('values follow the help_ prefix convention', () => {
    for (const value of Object.values(HELP_EVENTS)) {
      expect(value).toMatch(/^help_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('HELP_AUDIENCES', () => {
  it('is the exact pinned tuple, client first', () => {
    expect(HELP_AUDIENCES).toEqual(['client', 'expert']);
  });
});

describe('HELP_ARTICLE_SOURCES', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(HELP_ARTICLE_SOURCES).toEqual(['index', 'related', 'product', 'external']);
  });
});

describe('HELP_FEEDBACK_COMMENT_MAX', () => {
  it('is 1000', () => {
    expect(HELP_FEEDBACK_COMMENT_MAX).toBe(1000);
  });
});
