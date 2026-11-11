import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MEETINGS_CHANGED_EVENT,
  MEETING_CHANGE_EVENTS,
  MEETING_CHANGE_NAMESPACES,
  dispatchMeetingsChanged,
  hasNewMeetingChange,
  isMeetingChangeNotification,
} from './meetings-changed-event';

describe('isMeetingChangeNotification', () => {
  it.each([
    ['booking.confirmed', true],
    ['booking.cancelled', true],
    ['reschedule_proposal.proposed', true],
    ['meeting.starting_soon', true],
    ['bookingx.y', false],
    ['conversation.message', false],
    ['conversation.intro_call_booked', true],
    ['conversation.message_posted', false],
    ['project.kickoff_approved', true],
    ['project.proposal_sent', false],
    ['booking', true],
    ['', false],
  ])('%s → %s', (event, expected) => {
    expect(isMeetingChangeNotification(event)).toBe(expected);
  });

  it('pins the namespace tuple', () => {
    expect(MEETING_CHANGE_NAMESPACES).toEqual(['booking', 'reschedule_proposal', 'meeting']);
  });

  it('pins the exact-event allowlist', () => {
    expect(MEETING_CHANGE_EVENTS).toEqual([
      'conversation.intro_call_booked',
      'project.kickoff_approved',
    ]);
  });
});

describe('hasNewMeetingChange', () => {
  const booking = { id: 'n1', event: 'booking.confirmed' };
  const message = { id: 'n2', event: 'conversation.message' };

  it('seeds on the first load: a null known set is never a change', () => {
    expect(hasNewMeetingChange(null, [booking])).toBe(false);
  });

  it('is true for an unseen meeting-change notification', () => {
    expect(hasNewMeetingChange(new Set(['n2']), [booking, message])).toBe(true);
  });

  it('is false when the meeting-change id was already known', () => {
    expect(hasNewMeetingChange(new Set(['n1']), [booking])).toBe(false);
  });

  it('is false for an unseen notification outside the meeting namespaces', () => {
    expect(hasNewMeetingChange(new Set(), [message])).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(hasNewMeetingChange(new Set(), [])).toBe(false);
  });
});

describe('dispatchMeetingsChanged', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('raises the window event', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);

    dispatchMeetingsChanged();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const [event] = dispatchEvent.mock.calls[0] as [Event];
    expect(event.type).toBe(MEETINGS_CHANGED_EVENT);
  });
});
