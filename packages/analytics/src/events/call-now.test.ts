import { describe, it, expect } from 'vitest';
import {
  CALL_NOW_EVENTS,
  CALL_NOW_SERVER_EVENTS,
  type CallNowEventMap,
  type CallNowPresence,
  type CallNowRefusedReason,
  type CallNowServerEventMap,
} from './call-now';

describe('CALL_NOW_SERVER_EVENTS', () => {
  it('exposes exactly the call-now server events', () => {
    expect(Object.keys(CALL_NOW_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'REFUSED',
      'RING_ENDED',
      'SMS_SENT',
      'SMS_SUPPRESSED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(CALL_NOW_SERVER_EVENTS.RING_ENDED).toBe('call_now_ring_ended');
    expect(CALL_NOW_SERVER_EVENTS.SMS_SENT).toBe('call_sms_sent');
    expect(CALL_NOW_SERVER_EVENTS.SMS_SUPPRESSED).toBe('call_sms_suppressed');
    expect(CALL_NOW_SERVER_EVENTS.REFUSED).toBe('call_now_refused');
  });

  it('uses snake_case event values with the feature prefix', () => {
    for (const value of Object.values(CALL_NOW_SERVER_EVENTS)) {
      expect(value).toMatch(/^call_(now|sms)(_[a-z]+)+$/);
    }
  });

  it('types every outcome the ring can end with, and the placement and reach dimensions', () => {
    const base: CallNowServerEventMap['call_now_ring_ended'] = {
      outcome: 'connected',
      ring_seconds: 12,
      caller_lens: 'client',
      reached_by: 'app',
      placement: 'new_meeting',
      meeting_id: 'meeting-1',
      attempt_id: 'attempt-1',
      callee_presence_at_start: 'online',
      in_place_of_booking: false,
      attempt_number_today: 1,
      distinct_id: 'user-1',
    };
    const outcomes = (['connected', 'no_answer', 'declined', 'stopped'] as const).map(
      (outcome) => ({ ...base, outcome }).outcome
    );

    expect(outcomes).toEqual(['connected', 'no_answer', 'declined', 'stopped']);
    expect({
      ...base,
      placement: 'in_place',
      reached_by: 'sms',
      caller_lens: 'expert',
    }).toMatchObject({
      placement: 'in_place',
      reached_by: 'sms',
      caller_lens: 'expert',
    });
  });

  it('types the SMS events with the callee audience, the ring and the caller as distinct id', () => {
    const sent: CallNowServerEventMap['call_sms_sent'] = {
      audience: 'expert',
      ring_id: 'ring-1',
      distinct_id: 'caller-1',
    };
    const suppressed: CallNowServerEventMap['call_sms_suppressed'] = {
      ...sent,
      audience: 'client',
      reason: 'not_opted_in',
    };
    const reasons = (
      ['no_number', 'not_opted_in', 'active_in_app', 'outside_hours', 'cap'] as const
    ).map((reason) => ({ ...suppressed, reason }).reason);

    expect(sent).toEqual({ audience: 'expert', ring_id: 'ring-1', distinct_id: 'caller-1' });
    expect(suppressed).toMatchObject({ audience: 'client', reason: 'not_opted_in' });
    expect(reasons).toHaveLength(5);
  });

  it('types the ring end’s BAL-651 attempt props, each nullable one accepting null', () => {
    const preAttempt: CallNowServerEventMap['call_now_ring_ended'] = {
      outcome: 'no_answer',
      ring_seconds: 45,
      caller_lens: 'expert',
      reached_by: 'sms',
      placement: 'in_place',
      meeting_id: 'meeting-1',
      attempt_id: null,
      callee_presence_at_start: 'offline',
      in_place_of_booking: true,
      attempt_number_today: null,
      distinct_id: 'user-1',
    };

    expect(preAttempt).toMatchObject({
      attempt_id: null,
      callee_presence_at_start: 'offline',
      in_place_of_booking: true,
      attempt_number_today: null,
    });
  });

  it('types `call_now_refused` with the caller lens and every refusal reason', () => {
    const reasons = (
      [
        'busy',
        'outside_hours',
        'call_now_unavailable',
        'in_place_not_allowed',
        'in_place_not_eligible',
        'venue_unavailable',
        'rate_limited',
        'account_on_hold',
        'booking_unfunded',
        'booking_reserved',
        'booking_funding_unavailable',
      ] as const
    ).map((reason): CallNowServerEventMap['call_now_refused'] => ({
      caller_lens: 'client',
      reason,
      distinct_id: 'caller-1',
    }));
    // @ts-expect-error — `case_not_found` precedes authorization, so it is never a refusal reason.
    const preAuth: CallNowRefusedReason = 'case_not_found';

    expect(new Set(reasons.map((p) => p.reason)).size).toBe(11);
    expect(preAuth).toBe('case_not_found');
  });
});

describe('CALL_NOW_EVENTS', () => {
  it('exposes exactly the client events: the funding gate and the caller funnel', () => {
    expect(Object.keys(CALL_NOW_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'ABANDONED',
      'BOOK_INSTEAD_CLICKED',
      'CLICKED',
      'CONFIRMED',
      'FUNDING_GATE_RESOLVED',
      'FUNDING_GATE_SHOWN',
      'MISSED_CALL_BACK_CLICKED',
      'MISSED_TOAST_DISMISSED',
      'TOAST_DECLINED',
      'TOAST_JOIN_CLICKED',
      'TOAST_SHOWN',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN).toBe('call_now_funding_gate_shown');
    expect(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED).toBe('call_now_funding_gate_resolved');
    expect(CALL_NOW_EVENTS.CLICKED).toBe('call_now_clicked');
    expect(CALL_NOW_EVENTS.CONFIRMED).toBe('call_now_confirmed');
    expect(CALL_NOW_EVENTS.ABANDONED).toBe('call_now_abandoned');
    expect(CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED).toBe('call_now_book_instead_clicked');
    expect(CALL_NOW_EVENTS.TOAST_SHOWN).toBe('call_toast_shown');
    expect(CALL_NOW_EVENTS.TOAST_JOIN_CLICKED).toBe('call_toast_join_clicked');
    expect(CALL_NOW_EVENTS.TOAST_DECLINED).toBe('call_toast_declined');
    expect(CALL_NOW_EVENTS.MISSED_TOAST_DISMISSED).toBe('missed_call_toast_dismissed');
    expect(CALL_NOW_EVENTS.MISSED_CALL_BACK_CLICKED).toBe('missed_call_call_back_clicked');
  });

  it('types the toast events with the ticket’s exact properties', () => {
    const shown: CallNowEventMap['call_toast_shown'] = { mode: 'ringing', trigger: 'live' };
    const join: CallNowEventMap['call_toast_join_clicked'] = {
      lens: 'client',
      awaits_answer: true,
    };
    const declined: CallNowEventMap['call_toast_declined'] = { lens: 'expert' };
    const dismissed: CallNowEventMap['missed_call_toast_dismissed'] = { missed_count: 2 };
    const callBack: CallNowEventMap['missed_call_call_back_clicked'] = { missed_count: 1 };
    expect([shown.mode, join.awaits_answer, declined.lens, dismissed.missed_count]).toEqual([
      'ringing',
      true,
      'expert',
      2,
    ]);
    expect(callBack.missed_count).toBe(1);
  });

  it('types the four funnel events with the ticket’s exact properties', () => {
    const clicked: CallNowEventMap['call_now_clicked'] = {
      attempt_id: 'attempt-1',
      lens: 'client',
      callee_presence: 'offline',
      has_booking_today: true,
      surface: 'desktop',
      entry: 'party_card',
    };
    const confirmed: CallNowEventMap['call_now_confirmed'] = {
      attempt_id: 'attempt-1',
      lens: 'client',
      callee_presence: 'offline',
      choice: 'call_anyway',
      in_place_of_booking: false,
      surface: 'mobile',
    };
    const abandoned: CallNowEventMap['call_now_abandoned'] = {
      attempt_id: 'attempt-1',
      lens: 'expert',
      callee_presence: 'offline',
      step: 'calling',
      via: 'stop_calling',
      surface: 'desktop',
    };
    const bookInstead: CallNowEventMap['call_now_book_instead_clicked'] = {
      attempt_id: 'attempt-1',
      lens: 'client',
      from: 'confirm_offline',
      surface: 'desktop',
    };

    expect(Object.keys(clicked).sort((a, b) => a.localeCompare(b))).toEqual([
      'attempt_id',
      'callee_presence',
      'entry',
      'has_booking_today',
      'lens',
      'surface',
    ]);
    expect(Object.keys(confirmed).sort((a, b) => a.localeCompare(b))).toEqual([
      'attempt_id',
      'callee_presence',
      'choice',
      'in_place_of_booking',
      'lens',
      'surface',
    ]);
    expect(Object.keys(abandoned).sort((a, b) => a.localeCompare(b))).toEqual([
      'attempt_id',
      'callee_presence',
      'lens',
      'step',
      'surface',
      'via',
    ]);
    expect(Object.keys(bookInstead).sort((a, b) => a.localeCompare(b))).toEqual([
      'attempt_id',
      'from',
      'lens',
      'surface',
    ]);
  });

  it('`callee_presence` is online or offline only — there is no `unknown` arm', () => {
    const values: CallNowPresence[] = ['online', 'offline'];
    // @ts-expect-error — the expert arm reports the loader's `false` as `offline`, never `unknown`.
    const unknown: CallNowPresence = 'unknown';

    expect(values).toEqual(['online', 'offline']);
    expect(unknown).toBe('unknown');
  });

  it('uses snake_case event values with the feature prefix', () => {
    for (const value of Object.values(CALL_NOW_EVENTS)) {
      expect(value).toMatch(/^(call_now|call_toast|missed_call)(_[a-z]+)+$/);
    }
  });

  it('never shares a name with a server event', () => {
    const server = new Set<string>(Object.values(CALL_NOW_SERVER_EVENTS));
    for (const value of Object.values(CALL_NOW_EVENTS)) {
      expect(server.has(value)).toBe(false);
    }
  });

  it('types every gate reason and resolution', () => {
    const shown = (['account_on_hold', 'insufficient', 'reserved_by_upcoming'] as const).map(
      (reason): CallNowEventMap['call_now_funding_gate_shown'] => ({
        caller_lens: 'client',
        reason,
      })
    );
    const resolved = (['top_up', 'booking_in_place', 'abandoned'] as const).map(
      (via): CallNowEventMap['call_now_funding_gate_resolved'] => ({ via })
    );

    expect(shown.map((p) => p.reason)).toEqual([
      'account_on_hold',
      'insufficient',
      'reserved_by_upcoming',
    ]);
    expect(resolved.map((p) => p.via)).toEqual(['top_up', 'booking_in_place', 'abandoned']);
  });
});
