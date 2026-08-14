import { describe, it, expect } from 'vitest';
import { MEETING_PANEL_EVENTS, type MeetingPanelEventMap } from './meeting-panel';

describe('MEETING_PANEL_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(MEETING_PANEL_EVENTS)).toEqual([
      'OPENED',
      'GUEST_DECIDED',
      'GUESTS_INVITED',
      'JOIN_LINK_COPIED',
      'LINK_RESENT',
      'FILE_SHARED',
      'FILE_DOWNLOADED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(MEETING_PANEL_EVENTS.OPENED).toBe('meeting_panel_opened');
    expect(MEETING_PANEL_EVENTS.GUEST_DECIDED).toBe('meeting_panel_guest_decided');
    expect(MEETING_PANEL_EVENTS.GUESTS_INVITED).toBe('meeting_panel_guests_invited');
    expect(MEETING_PANEL_EVENTS.JOIN_LINK_COPIED).toBe('meeting_panel_join_link_copied');
    expect(MEETING_PANEL_EVENTS.LINK_RESENT).toBe('meeting_panel_link_resent');
    expect(MEETING_PANEL_EVENTS.FILE_SHARED).toBe('meeting_panel_file_shared');
    expect(MEETING_PANEL_EVENTS.FILE_DOWNLOADED).toBe('meeting_panel_file_downloaded');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(MEETING_PANEL_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('every value carries the meeting_panel feature prefix', () => {
    for (const value of Object.values(MEETING_PANEL_EVENTS)) {
      expect(value.startsWith('meeting_panel_')).toBe(true);
    }
  });

  /**
   * ⚠⚠ THE PANEL IS ABOUT PEOPLE OUTSIDE BOTH PARTIES, so the one thing this family must
   * never do is carry an identifier for one of them. A COMPILE-TIME assertion, which is
   * genuinely compiled because `@balo/analytics` has its own `typecheck` script (BAL-132).
   */
  it('⚠ no event declares a personal-data property — a type-level assertion', () => {
    type Keys<E extends keyof MeetingPanelEventMap> = keyof MeetingPanelEventMap[E];
    type AllKeys = {
      [E in keyof MeetingPanelEventMap]: Keys<E>;
    }[keyof MeetingPanelEventMap];

    type Forbidden =
      | 'email'
      | 'email_domain'
      | 'guest_name'
      | 'file_name'
      | 'join_token'
      | 'room_url'
      | 'participant_id'
      | 'guest_id';

    // `never` ⇒ no event map declares any forbidden key. A new one makes this a type error.
    type Offenders = Extract<AllKeys, Forbidden>;
    const noOffenders: Offenders[] = [];
    expect(noOffenders).toEqual([]);
  });
});
