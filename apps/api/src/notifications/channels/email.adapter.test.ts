import { describe, it, expect } from 'vitest';
import { getEmailTemplate } from './templates/index.js';

// -- Test getEmailTemplate --------------------------------------------------
//
// BAL-420: `logNotification`'s tests moved to ./log.test.ts, alongside the new BAL-341
// three-recipient-shape assertions. Keeping them here would have duplicated that file's
// `@balo/db` + `@balo/shared/logging` mock blocks verbatim across two files.

describe('getEmailTemplate', () => {
  it('returns welcome template with correct subject', () => {
    const result = getEmailTemplate('welcome', { recipientName: 'Alice' });
    expect(result.subject).toBe('Welcome to Balo, Alice!');
    expect(result.component).toBeDefined();
  });

  it('returns application-submitted template with correct subject', () => {
    const result = getEmailTemplate('application-submitted', {
      recipientName: 'Bob',
    });
    expect(result.subject).toBe('Application received, Bob.');
    expect(result.component).toBeDefined();
  });

  it('falls back to "there" when recipientName is missing', () => {
    const result = getEmailTemplate('welcome', {});
    expect(result.subject).toBe('Welcome to Balo, there!');
    expect(result.component).toBeDefined();
  });

  it('returns project-request-submitted template with title-based subject + counts', () => {
    const result = getEmailTemplate('project-request-submitted', {
      recipientName: 'Erin',
      title: 'Lead routing rebuild',
      tagIds: ['t1', 't2'],
      productIds: ['p1'],
      documentCount: 2,
    });
    expect(result.subject).toBe('New project request: Lead routing rebuild');
    expect(result.component).toBeDefined();
  });

  it('returns project-match-requested template with company name from data.company', () => {
    const result = getEmailTemplate('project-match-requested', {
      title: 'Lead routing rebuild',
      company: { name: 'Acme Inc' },
      tagIds: ['t1'],
      productIds: [],
      documentCount: 0,
    });
    expect(result.subject).toBe('New unrouted brief: Lead routing rebuild');
    expect(result.component).toBeDefined();
  });

  it('falls back to "a new project" when match title is missing', () => {
    const result = getEmailTemplate('project-match-requested', {});
    expect(result.subject).toBe('New unrouted brief: a new project');
    expect(result.component).toBeDefined();
  });

  it('throws for unknown template', () => {
    expect(() => getEmailTemplate('nonexistent', {})).toThrow(
      'Unknown email template: nonexistent'
    );
  });
});
