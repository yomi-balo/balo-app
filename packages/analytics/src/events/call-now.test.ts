import { describe, it, expect } from 'vitest';
import {
  CALL_NOW_EVENTS,
  CALL_NOW_SERVER_EVENTS,
  type CallNowEventMap,
  type CallNowServerEventMap,
} from './call-now';

describe('CALL_NOW_SERVER_EVENTS', () => {
  it('exposes exactly the call-now server events', () => {
    expect(Object.keys(CALL_NOW_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'RING_ENDED',
      'SMS_SENT',
      'SMS_SUPPRESSED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(CALL_NOW_SERVER_EVENTS.RING_ENDED).toBe('call_now_ring_ended');
    expect(CALL_NOW_SERVER_EVENTS.SMS_SENT).toBe('call_sms_sent');
    expect(CALL_NOW_SERVER_EVENTS.SMS_SUPPRESSED).toBe('call_sms_suppressed');
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
});

describe('CALL_NOW_EVENTS', () => {
  it('exposes exactly the BAL-650 funding-gate client events', () => {
    expect(Object.keys(CALL_NOW_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'ATTEMPT_ABANDONED',
      'DIALOG_CONFIRMED',
      'ENTRY_CLICKED',
      'FUNDING_GATE_RESOLVED',
      'FUNDING_GATE_SHOWN',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN).toBe('call_now_funding_gate_shown');
    expect(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED).toBe('call_now_funding_gate_resolved');
    expect(CALL_NOW_EVENTS.ENTRY_CLICKED).toBe('call_now_entry_clicked');
    expect(CALL_NOW_EVENTS.DIALOG_CONFIRMED).toBe('call_now_dialog_confirmed');
    expect(CALL_NOW_EVENTS.ATTEMPT_ABANDONED).toBe('call_now_attempt_abandoned');
  });

  it('uses snake_case event values with the feature prefix', () => {
    for (const value of Object.values(CALL_NOW_EVENTS)) {
      expect(value).toMatch(/^call_now(_[a-z]+)+$/);
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
