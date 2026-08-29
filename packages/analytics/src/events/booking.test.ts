import { describe, it, expect } from 'vitest';
import { BOOKING_EVENTS } from './booking';

describe('BOOKING_EVENTS', () => {
  it('exposes exactly the booking CLIENT events (guards against accidental drift)', () => {
    expect(Object.keys(BOOKING_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'ABANDONED',
      'ATTACHED_TO_CASE',
      'CANCEL_ABANDONED',
      'CANCELLED',
      'CASE_BOOKED',
      'CASE_CHOICE_SHOWN',
      'COMPANY_SELECTION_SHOWN',
      'CONFIRM_VIEWED',
      'FLOW_OPENED',
      'GUESTS_INVITED',
      'RESCHEDULE_PROPOSAL_ANSWERED',
      'RESCHEDULE_PROPOSAL_SLOT_LOST',
      'RESCHEDULE_PROPOSED',
      'RESCHEDULED',
    ]);
  });

  it('maps every constant to its exact snake_case wire value', () => {
    expect(BOOKING_EVENTS.FLOW_OPENED).toBe('booking_flow_opened');
    expect(BOOKING_EVENTS.CONFIRM_VIEWED).toBe('booking_confirm_viewed');
    expect(BOOKING_EVENTS.CASE_CHOICE_SHOWN).toBe('booking_case_choice_shown');
    expect(BOOKING_EVENTS.ATTACHED_TO_CASE).toBe('booking_attached_to_case');
    expect(BOOKING_EVENTS.COMPANY_SELECTION_SHOWN).toBe('booking_company_selection_shown');
    expect(BOOKING_EVENTS.GUESTS_INVITED).toBe('booking_guests_invited');
    expect(BOOKING_EVENTS.CASE_BOOKED).toBe('case_booked');
    expect(BOOKING_EVENTS.ABANDONED).toBe('booking_abandoned');
    expect(BOOKING_EVENTS.RESCHEDULED).toBe('booking_rescheduled');
    expect(BOOKING_EVENTS.CANCELLED).toBe('booking_cancelled');
    expect(BOOKING_EVENTS.CANCEL_ABANDONED).toBe('booking_cancel_abandoned');
    expect(BOOKING_EVENTS.RESCHEDULE_PROPOSED).toBe('reschedule_proposed');
    expect(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_ANSWERED).toBe('reschedule_proposal_answered');
    expect(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_SLOT_LOST).toBe('reschedule_proposal_slot_lost');
  });

  it('uses snake_case event values throughout', () => {
    for (const value of Object.values(BOOKING_EVENTS)) {
      expect(value).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});
