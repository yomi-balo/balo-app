import { describe, it, expect } from 'vitest';
import {
  conversationSubjectForMeetingContext,
  engagementConversationIsWritable,
  resolveGuestConversationScope,
  type ConversationSubject,
  type EngagementStatusLabel,
} from './index';
import type { MeetingContextTypeWithHolder, SelectPrimaryMeetingContextResult } from '../meetings';

const ENGAGEMENT_ID = '11111111-1111-4111-8111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const GUEST_MEETING_ID = '44444444-4444-4444-8444-444444444444';

function primary(
  contextType: MeetingContextTypeWithHolder,
  contextId: string
): SelectPrimaryMeetingContextResult {
  return { ok: true, context: { contextType, contextId } };
}

describe('conversationSubjectForMeetingContext', () => {
  // The four ENGAGEMENT-grain labels all collapse onto ONE conversation label — that
  // collapse is what makes kickoff carry-over a single context row rather than four.
  it.each(['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const)(
    'maps %s to the engagement anchor',
    (contextType) => {
      expect(
        conversationSubjectForMeetingContext({ contextType, contextId: ENGAGEMENT_ID })
      ).toEqual({ contextType: 'engagement', contextId: ENGAGEMENT_ID });
    }
  );

  it('maps request_interaction to the relationship anchor', () => {
    expect(
      conversationSubjectForMeetingContext({
        contextType: 'request_interaction',
        contextId: RELATIONSHIP_ID,
      })
    ).toEqual({ contextType: 'relationship', contextId: RELATIONSHIP_ID });
  });

  /**
   * ⚠ THE FAIL-CLOSED ARM. A discovery meeting names a `project_requests.id`, which fans out
   * to EVERY invited expert's thread — so it implies no single conversation and must not
   * resolve to one.
   */
  it('maps project_discovery to null — a request names no single thread', () => {
    expect(
      conversationSubjectForMeetingContext({
        contextType: 'project_discovery',
        contextId: REQUEST_ID,
      })
    ).toBeNull();
  });
});

describe('resolveGuestConversationScope', () => {
  const engagementContexts: ConversationSubject[] = [
    { contextType: 'engagement', contextId: ENGAGEMENT_ID },
  ];

  /**
   * ⚠ A `meeting`-SCOPED GRANT CAN NEVER BE WIDENED BY DATA. The narrow answer is returned
   * before any context is even consulted, so no shape of `conversationContexts` promotes it.
   */
  it('returns the meeting scope for a meeting-level guest, whatever the contexts say', () => {
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'meeting',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('case', ENGAGEMENT_ID),
        conversationContexts: engagementContexts,
      })
    ).toEqual({ kind: 'meeting', meetingId: GUEST_MEETING_ID });
  });

  it('grants full scope to an engagement guest whose engagement anchors the thread', () => {
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'engagement',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('case', ENGAGEMENT_ID),
        conversationContexts: engagementContexts,
      })
    ).toEqual({ kind: 'full' });
  });

  it('grants full scope through a carried-over thread that also holds a relationship context', () => {
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'engagement',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('project_kickoff', ENGAGEMENT_ID),
        conversationContexts: [
          { contextType: 'relationship', contextId: RELATIONSHIP_ID },
          { contextType: 'engagement', contextId: ENGAGEMENT_ID },
        ],
      })
    ).toEqual({ kind: 'full' });
  });

  it('narrows an engagement guest to their own call when the thread is another engagement', () => {
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'engagement',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('case', ENGAGEMENT_ID),
        conversationContexts: [
          { contextType: 'engagement', contextId: '99999999-9999-4999-8999-999999999999' },
        ],
      })
    ).toEqual({ kind: 'meeting', meetingId: GUEST_MEETING_ID });
  });

  it('narrows an engagement guest whose own meeting is a project_discovery', () => {
    // Their meeting names a REQUEST, so there is no envelope-wide grant to give — but they
    // still keep their own call.
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'engagement',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('project_discovery', REQUEST_ID),
        conversationContexts: engagementContexts,
      })
    ).toEqual({ kind: 'meeting', meetingId: GUEST_MEETING_ID });
  });

  /**
   * ⚠ FAIL-CLOSED ON AN UNRESOLVABLE OWN-MEETING. `none` and `ambiguous` both DENY — never a
   * silent fallback to `full`, and deliberately not even to the meeting scope: if we cannot
   * say what the guest's own meeting is for, we cannot say what they may read.
   */
  it.each(['none', 'ambiguous'] as const)(
    'denies outright when the guest meeting context is %s',
    (reason) => {
      expect(
        resolveGuestConversationScope({
          guestAccessScope: 'engagement',
          guestMeetingId: GUEST_MEETING_ID,
          guestMeetingPrimaryContext: { ok: false, reason },
          conversationContexts: engagementContexts,
        })
      ).toBeNull();
    }
  );

  it('narrows an engagement guest when the thread has no live contexts at all', () => {
    expect(
      resolveGuestConversationScope({
        guestAccessScope: 'engagement',
        guestMeetingId: GUEST_MEETING_ID,
        guestMeetingPrimaryContext: primary('case', ENGAGEMENT_ID),
        conversationContexts: [],
      })
    ).toEqual({ kind: 'meeting', meetingId: GUEST_MEETING_ID });
  });
});

describe('engagementConversationIsWritable', () => {
  // A closed case is READ-ONLY, permanently: `close()` writes `completed` and nothing ever
  // clears it. Read-only means the WRITE path refuses — the history stays fully readable.
  it.each<[EngagementStatusLabel, boolean]>([
    ['active', true],
    ['completed', false],
    ['cancelled', false],
  ])('%s → %s', (status, expected) => {
    expect(engagementConversationIsWritable(status)).toBe(expected);
  });
});
