import { describe, it, expect } from 'vitest';
import {
  deriveThreadStage,
  insertUpcomingCall,
  isConversationReadOnly,
  isThreadOpenStatus,
  isUpcomingContextMeeting,
  mergeUpcomingCalls,
  messagePreviewText,
  SHARED_FILE_PREVIEW,
  pickDefaultThread,
  previewOfHtml,
  previewOfPlainText,
  PREVIEW_MAX_CHARS,
  requestStatusRank,
  THREAD_OPEN_RELATIONSHIP_STATUSES,
  threadAdmits,
  UPCOMING_CALL_CAP,
  upcomingCallCapCopy,
  type UpcomingCallView,
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

describe('thread-open definition is the shared one', () => {
  it('re-exports the same constant and predicate as @balo/shared/conversations', async () => {
    const shared = await import('@balo/shared/conversations');
    expect(THREAD_OPEN_RELATIONSHIP_STATUSES).toBe(shared.THREAD_OPEN_RELATIONSHIP_STATUSES);
    expect(isThreadOpenStatus).toBe(shared.isThreadOpenStatus);
  });
});

describe('messagePreviewText', () => {
  it('previews the plain text of an ordinary message', () => {
    expect(messagePreviewText('<p>Hello there</p>', null)).toBe('Hello there');
  });

  it('is null for an empty ordinary message', () => {
    expect(messagePreviewText('', null)).toBeNull();
  });

  it('falls back to "Shared a file" for a note-less share card', () => {
    expect(SHARED_FILE_PREVIEW).toBe('Shared a file');
    expect(messagePreviewText('', 'file-1')).toBe('Shared a file');
  });

  it('never previews the note of a share card', () => {
    expect(messagePreviewText('<p>The spec</p>', 'file-1')).toBe('Shared a file');
  });

  it('names no file and no audience in the fallback', () => {
    expect(messagePreviewText('', 'file-1')).not.toMatch(/\.|expert|everyone/i);
  });
});

describe('isConversationReadOnly', () => {
  it('is true only for a closed request', () => {
    expect(isConversationReadOnly('closed')).toBe(true);
    expect(isConversationReadOnly('accepted')).toBe(false);
    expect(isConversationReadOnly('eoi_submitted')).toBe(false);
  });
});

describe('threadAdmits (BAL-616)', () => {
  const OPENED = new Date('2026-10-01T00:00:00Z');
  const closedRecord = {
    status: 'declined',
    declineReason: 'request_closed',
    openedAt: OPENED,
  } as const;

  it("admits a thread that was open at the close under 'records' only", () => {
    expect(threadAdmits(closedRecord, 'closed', 'records')).toBe(true);
    expect(threadAdmits(closedRecord, 'closed', 'live')).toBe(false);
  });

  it('never admits a track declined before the close, or one that never opened', () => {
    const before = { ...closedRecord, declineReason: 'client_declined' } as const;
    const unopened = { ...closedRecord, openedAt: null };
    for (const admission of ['live', 'records'] as const) {
      expect(threadAdmits(before, 'closed', admission)).toBe(false);
      expect(threadAdmits(unopened, 'closed', admission)).toBe(false);
    }
  });

  it('refuses an accepted relationship on a closed request for live, whatever the cascade did', () => {
    const accepted = { status: 'accepted', declineReason: null, openedAt: OPENED } as const;
    expect(threadAdmits(accepted, 'closed', 'live')).toBe(false);
    expect(threadAdmits(accepted, 'closed', 'records')).toBe(false);
  });

  it("on a live request 'records' equals 'live' for every relationship status", () => {
    const statuses = [...THREAD_OPEN_RELATIONSHIP_STATUSES, 'invited', 'declined'] as const;
    for (const status of statuses) {
      for (const declineReason of [null, 'request_closed'] as const) {
        const r = { status, declineReason, openedAt: OPENED };
        const live = threadAdmits(r, 'proposal_submitted', 'live');
        expect(threadAdmits(r, 'proposal_submitted', 'records')).toBe(live);
        expect(live).toBe(isThreadOpenStatus(status));
      }
    }
  });
});

describe('requestStatusRank', () => {
  it('orders the pipeline statuses', () => {
    expect(requestStatusRank('eoi_submitted')).toBeLessThan(requestStatusRank('kickoff_approved'));
    expect(requestStatusRank('accepted')).toBeLessThan(requestStatusRank('kickoff_approved'));
  });

  it('BAL-540: closed ranks LAST, never -1 (the root cause of the fail-open sweep)', () => {
    expect(requestStatusRank('closed')).toBeGreaterThan(requestStatusRank('kickoff_approved'));
    expect(requestStatusRank('closed')).not.toBe(-1);
  });

  it('is TOTAL over every ProjectRequestStatus — no label yields -1', () => {
    const statuses = [
      'draft',
      'requested',
      'exploratory_meeting_requested',
      'experts_invited',
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
      'closed',
    ] as const;
    for (const status of statuses) {
      expect(requestStatusRank(status)).toBeGreaterThanOrEqual(0);
    }
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

  it("is 'request_closed' when the request is closed, checked BEFORE the 'won' test (BAL-540)", () => {
    expect(deriveThreadStage('proposal_submitted', 'closed')).toBe('request_closed');
    // Even a relationship that was accepted before the close has no winner once closed.
    expect(deriveThreadStage('accepted', 'closed')).toBe('request_closed');
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

describe('isUpcomingContextMeeting (shared rule, re-exported)', () => {
  const NOW = Date.parse('2026-08-25T00:00:00.000Z');

  it('is the shared rule, and the cap is 3', () => {
    const past = {
      status: 'scheduled' as const,
      scheduledEnd: new Date('2026-08-24T04:30:00.000Z'),
    };
    expect(isUpcomingContextMeeting(past, NOW)).toBe(false);
    expect(UPCOMING_CALL_CAP).toBe(3);
  });
});

describe('mergeUpcomingCalls', () => {
  const NOW = Date.parse('2026-08-25T00:00:00.000Z');

  function summary(id: string, startIso: string, overrides: Record<string, unknown> = {}) {
    const start = new Date(startIso);
    return {
      meetingId: id,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
      status: 'scheduled' as const,
      ...overrides,
    };
  }

  it('de-duplicates a meeting present in both sources to one project_call item', () => {
    const shared = summary('m-1', '2026-08-26T04:00:00.000Z');
    const merged = mergeUpcomingCalls(
      [
        { contextType: 'request_interaction', meetings: [shared] },
        { contextType: 'project_call', meetings: [shared] },
      ],
      NOW
    );
    expect(merged).toEqual([
      {
        meetingId: 'm-1',
        scheduledStartIso: '2026-08-26T04:00:00.000Z',
        contextType: 'project_call',
      },
    ]);
  });

  it('keeps project_call when it is listed first and request_interaction second', () => {
    const shared = summary('m-1', '2026-08-26T04:00:00.000Z');
    const merged = mergeUpcomingCalls(
      [
        { contextType: 'project_call', meetings: [shared] },
        { contextType: 'request_interaction', meetings: [shared] },
      ],
      NOW
    );
    expect(merged.map((c) => c.contextType)).toEqual(['project_call']);
  });

  it('orders soonest first with a meeting-id tiebreak', () => {
    const merged = mergeUpcomingCalls(
      [
        {
          contextType: 'request_interaction',
          meetings: [
            summary('m-b', '2026-08-26T04:00:00.000Z'),
            summary('m-late', '2026-08-28T04:00:00.000Z'),
          ],
        },
        {
          contextType: 'project_call',
          meetings: [
            summary('m-a', '2026-08-26T04:00:00.000Z'),
            summary('m-early', '2026-08-25T04:00:00.000Z'),
          ],
        },
      ],
      NOW
    );
    expect(merged.map((c) => c.meetingId)).toEqual(['m-early', 'm-a', 'm-b', 'm-late']);
  });

  it('drops ended and past-window meetings', () => {
    const merged = mergeUpcomingCalls(
      [
        {
          contextType: 'request_interaction',
          meetings: [
            summary('m-ended', '2026-08-26T04:00:00.000Z', { status: 'ended' }),
            summary('m-past', '2026-08-24T04:00:00.000Z'),
            summary('m-ok', '2026-08-27T04:00:00.000Z'),
          ],
        },
      ],
      NOW
    );
    expect(merged.map((c) => c.meetingId)).toEqual(['m-ok']);
  });

  it('returns an empty list when there are no sources', () => {
    expect(mergeUpcomingCalls([], NOW)).toEqual([]);
  });
});

describe('insertUpcomingCall', () => {
  const call = (id: string, iso: string): UpcomingCallView => ({
    meetingId: id,
    scheduledStartIso: iso,
    contextType: 'request_interaction',
  });

  it('keeps the list soonest first', () => {
    const list = [call('a', '2026-08-26T04:00:00.000Z'), call('c', '2026-08-28T04:00:00.000Z')];
    const next = insertUpcomingCall(list, call('b', '2026-08-27T04:00:00.000Z'));
    expect(next.map((c) => c.meetingId)).toEqual(['a', 'b', 'c']);
  });

  it('replaces a same-id entry instead of duplicating it', () => {
    const list = [call('a', '2026-08-26T04:00:00.000Z'), call('b', '2026-08-27T04:00:00.000Z')];
    const next = insertUpcomingCall(list, {
      ...call('a', '2026-08-29T04:00:00.000Z'),
      contextType: 'project_call',
    });
    expect(next.map((c) => c.meetingId)).toEqual(['b', 'a']);
    expect(next[1]?.contextType).toBe('project_call');
  });

  it('does not mutate the input list', () => {
    const list = [call('a', '2026-08-26T04:00:00.000Z')];
    insertUpcomingCall(list, call('b', '2026-08-25T04:00:00.000Z'));
    expect(list).toHaveLength(1);
  });
});

describe('upcomingCallCapCopy', () => {
  it('names the expert and states the verbatim cap copy', () => {
    expect(upcomingCallCapCopy('Priya')).toEqual({
      title: 'You have 3 calls booked with Priya.',
      body: 'Once one has happened you can book another.',
    });
  });
});
