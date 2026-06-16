import { describe, it, expect } from 'vitest';
import { PROJECTS_INBOX_EVENTS } from './projects-inbox';

describe('PROJECTS_INBOX_EVENTS', () => {
  it('has exactly the five A7 portfolio-dashboard events', () => {
    expect(Object.keys(PROJECTS_INBOX_EVENTS)).toEqual([
      'INBOX_VIEWED',
      'INBOX_FILTER_APPLIED',
      'INBOX_LENS_SWITCHED',
      'INBOX_HERO_CTA_CLICKED',
      'INBOX_LIST_ROW_CLICKED',
    ]);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(PROJECTS_INBOX_EVENTS)) {
      expect(value).toMatch(/^projects_inbox_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(PROJECTS_INBOX_EVENTS.INBOX_VIEWED).toBe('projects_inbox_viewed');
    expect(PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED).toBe('projects_inbox_filter_applied');
    expect(PROJECTS_INBOX_EVENTS.INBOX_LENS_SWITCHED).toBe('projects_inbox_lens_switched');
    expect(PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED).toBe('projects_inbox_hero_cta_clicked');
    expect(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED).toBe('projects_inbox_list_row_clicked');
  });
});
