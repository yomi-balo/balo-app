import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import {
  ProjectsInboxAnalytics,
  readTimeToFirstAction,
  INBOX_VIEWED_AT_KEY,
} from './projects-inbox-analytics';

const trackMock = vi.mocked(track);

describe('ProjectsInboxAnalytics', () => {
  beforeEach(() => {
    trackMock.mockClear();
    globalThis.sessionStorage.clear();
  });

  it('fires inbox_viewed on mount with the lens + counts', () => {
    render(
      <ProjectsInboxAnalytics lens="client" needsCount={2} inProgressCount={3} totalCount={6} />
    );
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_VIEWED, {
      lens: 'client',
      needs_count: 2,
      in_progress_count: 3,
      total_count: 6,
    });
  });

  it('seeds the first-action timestamp in sessionStorage', () => {
    render(
      <ProjectsInboxAnalytics lens="expert" needsCount={1} inProgressCount={0} totalCount={1} />
    );
    expect(globalThis.sessionStorage.getItem(INBOX_VIEWED_AT_KEY)).not.toBeNull();
  });

  it('readTimeToFirstAction returns a number then clears the seed', () => {
    globalThis.sessionStorage.setItem(INBOX_VIEWED_AT_KEY, String(Date.now() - 100));
    const ms = readTimeToFirstAction();
    expect(typeof ms).toBe('number');
    expect(ms).toBeGreaterThanOrEqual(0);
    // Second read returns null (seed consumed).
    expect(readTimeToFirstAction()).toBeNull();
  });

  it('readTimeToFirstAction returns null with no seed', () => {
    expect(readTimeToFirstAction()).toBeNull();
  });

  it('fires inbox_viewed for the admin lens', () => {
    render(
      <ProjectsInboxAnalytics lens="admin" needsCount={4} inProgressCount={5} totalCount={9} />
    );
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_VIEWED, {
      lens: 'admin',
      needs_count: 4,
      in_progress_count: 5,
      total_count: 9,
    });
  });
});
