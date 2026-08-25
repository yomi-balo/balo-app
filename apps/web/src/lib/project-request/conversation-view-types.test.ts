import { describe, it, expect } from 'vitest';
import {
  deriveThreadStage,
  isThreadOpenStatus,
  pickDefaultThread,
  pickUpcomingContextMeeting,
  previewOfHtml,
  previewOfPlainText,
  PREVIEW_MAX_CHARS,
  requestStatusRank,
  THREAD_OPEN_RELATIONSHIP_STATUSES,
} from './conversation-view-types';
import { thread } from '@/test/fixtures/conversation';

describe('isThreadOpenStatus', () => {
  it('opens exactly the four engaged statuses', () => {
    expect([...THREAD_OPEN_RELATIONSHIP_STATUSES]).toEqual([
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
    ]);
    expect(isThreadOpenStatus('eoi_submitted')).toBe(true);
    expect(isThreadOpenStatus('invited')).toBe(false);
    expect(isThreadOpenStatus('declined')).toBe(false);
  });
});

describe('requestStatusRank', () => {
  it('orders the pipeline statuses', () => {
    expect(requestStatusRank('eoi_submitted')).toBeLessThan(requestStatusRank('kickoff_approved'));
    expect(requestStatusRank('accepted')).toBeLessThan(requestStatusRank('kickoff_approved'));
  });
});

describe('deriveThreadStage', () => {
  it("is 'won' when the relationship is accepted", () => {
    expect(deriveThreadStage('accepted', 'accepted')).toBe('won');
    expect(deriveThreadStage('accepted', 'kickoff_approved')).toBe('won');
  });

  it("is 'not_selected' when the request is decided and this thread lost", () => {
    expect(deriveThreadStage('eoi_submitted', 'accepted')).toBe('not_selected');
    expect(deriveThreadStage('proposal_submitted', 'kickoff_approved')).toBe('not_selected');
  });

  it("is 'active' while the request is undecided", () => {
    expect(deriveThreadStage('eoi_submitted', 'eoi_submitted')).toBe('active');
    expect(deriveThreadStage('proposal_requested', 'proposal_requested')).toBe('active');
  });
});

describe('pickDefaultThread', () => {
  it('returns null for no threads', () => {
    expect(pickDefaultThread([])).toBeNull();
  });

  it('picks the freshest UNREAD thread first', () => {
    const threads = [
      thread({
        relationshipId: 'a',
        unread: true,
        latestInboundActivityAtIso: '2026-06-09T10:00:00.000Z',
      }),
      thread({
        relationshipId: 'b',
        unread: true,
        latestInboundActivityAtIso: '2026-06-09T12:00:00.000Z',
      }),
      thread({ relationshipId: 'c', latestMessageAtIso: '2026-06-09T15:00:00.000Z' }),
    ];
    expect(pickDefaultThread(threads)).toBe('b');
  });

  it('falls back to the most-recent message when nothing is unread', () => {
    const threads = [
      thread({ relationshipId: 'a', latestMessageAtIso: '2026-06-08T00:00:00.000Z' }),
      thread({ relationshipId: 'b', latestMessageAtIso: '2026-06-09T00:00:00.000Z' }),
    ];
    expect(pickDefaultThread(threads)).toBe('b');
  });

  it('falls back to the last-viewed thread when no messages exist', () => {
    const threads = [
      thread({ relationshipId: 'a' }),
      thread({ relationshipId: 'b', lastReadAtIso: '2026-06-07T00:00:00.000Z' }),
    ];
    expect(pickDefaultThread(threads)).toBe('b');
  });

  it('falls back to invite order when there is no activity at all', () => {
    const threads = [thread({ relationshipId: 'a' }), thread({ relationshipId: 'b' })];
    expect(pickDefaultThread(threads)).toBe('a');
  });

  it('resolves ties deterministically to the earlier thread in invite order', () => {
    const at = '2026-06-09T10:00:00.000Z';
    const threads = [
      thread({ relationshipId: 'a', unread: true, latestInboundActivityAtIso: at }),
      thread({ relationshipId: 'b', unread: true, latestInboundActivityAtIso: at }),
    ];
    expect(pickDefaultThread(threads)).toBe('a');
  });

  it('never reorders the input array', () => {
    const threads = [
      thread({ relationshipId: 'a' }),
      thread({
        relationshipId: 'b',
        unread: true,
        latestInboundActivityAtIso: '2026-06-09T10:00:00.000Z',
      }),
    ];
    pickDefaultThread(threads);
    expect(threads.map((t) => t.relationshipId)).toEqual(['a', 'b']);
  });

  it('fails soft to the first unread thread if unread carries no inbound timestamp', () => {
    const threads = [
      thread({ relationshipId: 'a' }),
      thread({ relationshipId: 'b', unread: true, latestInboundActivityAtIso: null }),
    ];
    expect(pickDefaultThread(threads)).toBe('b');
  });
});

describe('previewOfPlainText — the single 140-char truncation rule', () => {
  it('passes short text through untouched', () => {
    expect(previewOfPlainText('hello')).toBe('hello');
    expect(previewOfPlainText('a'.repeat(PREVIEW_MAX_CHARS))).toBe('a'.repeat(PREVIEW_MAX_CHARS));
  });

  it('truncates overflow to 139 chars + ellipsis, trimming a ragged edge', () => {
    // slice(0, 139) lands inside the whitespace run → trimEnd strips it.
    const long = `${'a'.repeat(135)}    ${'b'.repeat(30)}`;
    const result = previewOfPlainText(long);
    expect(result).toBe(`${'a'.repeat(135)}…`);
    expect(result.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);

    const solid = 'x'.repeat(200);
    expect(previewOfPlainText(solid)).toBe(`${'x'.repeat(PREVIEW_MAX_CHARS - 1)}…`);
  });
});

describe('previewOfHtml', () => {
  it('strips tags and entities before truncating', () => {
    expect(previewOfHtml('<p>Hello <strong>there</strong></p>')).toBe('Hello there');
  });

  it('returns null for effectively-empty HTML', () => {
    expect(previewOfHtml('<p></p>')).toBeNull();
    expect(previewOfHtml('')).toBeNull();
  });

  it('applies the shared truncation rule to long bodies', () => {
    expect(previewOfHtml(`<p>${'y'.repeat(300)}</p>`)).toBe(
      `${'y'.repeat(PREVIEW_MAX_CHARS - 1)}…`
    );
  });
});

/**
 * BAL-283 — THE ONE definition of "this thread has a live intro call", shared by
 * `loadConversationView` (what the CTA renders) and `assertNoLiveIntroCall` (what the server
 * enforces). If these two ever disagreed, the server would refuse bookings the UI was still
 * offering — so the rule is pinned here, once, in its pure form.
 */
describe('pickUpcomingContextMeeting', () => {
  const NOW = Date.parse('2026-08-25T00:00:00.000Z');

  function meeting(overrides: Record<string, unknown> = {}) {
    return {
      meetingId: 'meeting-1',
      scheduledStart: new Date('2026-08-26T04:00:00.000Z'),
      scheduledEnd: new Date('2026-08-26T04:30:00.000Z'),
      status: 'scheduled' as const,
      ...overrides,
    };
  }

  it('picks an upcoming meeting', () => {
    expect(pickUpcomingContextMeeting([meeting()], NOW)?.meetingId).toBe('meeting-1');
  });

  it('returns undefined for an empty list', () => {
    expect(pickUpcomingContextMeeting([], NOW)).toBeUndefined();
  });

  it.each(['scheduled', 'waiting_for_participants', 'in_progress'] as const)(
    'accepts a live status %s while the window is still ahead',
    (status) => {
      expect(pickUpcomingContextMeeting([meeting({ status })], NOW)).toBeDefined();
    }
  );

  it('rejects an ENDED meeting even when its window is somehow in the future', () => {
    expect(pickUpcomingContextMeeting([meeting({ status: 'ended' })], NOW)).toBeUndefined();
  });

  it('rejects a meeting whose window has already passed, whatever its status', () => {
    const past = meeting({
      scheduledStart: new Date('2026-08-24T04:00:00.000Z'),
      scheduledEnd: new Date('2026-08-24T04:30:00.000Z'),
    });
    expect(pickUpcomingContextMeeting([past], NOW)).toBeUndefined();
  });

  it('a meeting IN PROGRESS right now still counts — the end is what must be ahead', () => {
    const running = meeting({
      scheduledStart: new Date('2026-08-24T23:45:00.000Z'),
      scheduledEnd: new Date('2026-08-25T00:15:00.000Z'),
      status: 'in_progress' as const,
    });
    expect(pickUpcomingContextMeeting([running], NOW)).toBeDefined();
  });

  it('given a past call then an upcoming one, the UPCOMING one wins (repository order)', () => {
    const past = meeting({
      meetingId: 'meeting-past',
      scheduledStart: new Date('2026-08-20T04:00:00.000Z'),
      scheduledEnd: new Date('2026-08-20T04:30:00.000Z'),
      status: 'ended' as const,
    });
    const next = meeting({ meetingId: 'meeting-next' });
    expect(pickUpcomingContextMeeting([past, next], NOW)?.meetingId).toBe('meeting-next');
  });
});
