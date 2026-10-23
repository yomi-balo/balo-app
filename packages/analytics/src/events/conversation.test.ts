import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  CONVERSATION_CALL_ROUTES,
  CONVERSATION_CALL_SURFACES,
  CONVERSATION_EVENTS,
  type ConversationCallRoute,
  type ConversationEventMap,
} from './conversation';

describe('CONVERSATION_EVENTS', () => {
  it('has exactly the five A4 events, the A5 proposal CTA, and the two BAL-283 completion events', () => {
    expect(Object.keys(CONVERSATION_EVENTS)).toEqual([
      'CONVERSATION_MESSAGE_SENT',
      'CONVERSATION_FILE_SHARED',
      'CONVERSATION_THREAD_SELECTED',
      'CONVERSATION_FILES_OPENED',
      'CONVERSATION_CALL_CTA_CLICKED',
      'CONVERSATION_PROPOSAL_CTA_CLICKED',
      'CONVERSATION_AVAILABILITY_SHARED',
      'CONVERSATION_INTRO_CALL_BOOKED',
    ]);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(CONVERSATION_EVENTS)) {
      expect(value).toMatch(/^conversation_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(CONVERSATION_EVENTS.CONVERSATION_MESSAGE_SENT).toBe('conversation_message_sent');
    expect(CONVERSATION_EVENTS.CONVERSATION_FILE_SHARED).toBe('conversation_file_shared');
    expect(CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED).toBe('conversation_thread_selected');
    expect(CONVERSATION_EVENTS.CONVERSATION_FILES_OPENED).toBe('conversation_files_opened');
    expect(CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED).toBe('conversation_call_cta_clicked');
    expect(CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED).toBe(
      'conversation_proposal_cta_clicked'
    );
    expect(CONVERSATION_EVENTS.CONVERSATION_AVAILABILITY_SHARED).toBe(
      'conversation_availability_shared'
    );
    expect(CONVERSATION_EVENTS.CONVERSATION_INTRO_CALL_BOOKED).toBe(
      'conversation_intro_call_booked'
    );
  });
});

describe('CONVERSATION_CALL_SURFACES', () => {
  it('is exactly the five call-CTA surfaces, `kickoff_board` last (BAL-616)', () => {
    expect(CONVERSATION_CALL_SURFACES).toEqual([
      'header',
      'rail',
      'nudge',
      'page_nudge',
      'kickoff_board',
    ]);
  });
});

describe('CONVERSATION_CALL_ROUTES', () => {
  it('is exactly the two client call routes (BAL-616)', () => {
    expect(CONVERSATION_CALL_ROUTES).toEqual(['in_place', 'profile']);
  });
});

describe('BAL-616 call payloads', () => {
  it('CALL_CTA_CLICKED carries request_status, upcoming_count and a nullable route', () => {
    expectTypeOf<
      ConversationEventMap[typeof CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED]['route']
    >().toEqualTypeOf<ConversationCallRoute | null>();

    const expertPropose: ConversationEventMap[typeof CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED] =
      {
        request_id: 'request-1',
        relationship_id: 'relationship-1',
        lens: 'expert',
        surface: 'kickoff_board',
        request_status: 'accepted',
        upcoming_count: 0,
        route: null,
      };
    expect(Object.keys(expertPropose).sort((a, b) => a.localeCompare(b))).toEqual([
      'lens',
      'relationship_id',
      'request_id',
      'request_status',
      'route',
      'surface',
      'upcoming_count',
    ]);
  });

  it('INTRO_CALL_BOOKED carries the booked context_type and request_status', () => {
    expectTypeOf<
      ConversationEventMap[typeof CONVERSATION_EVENTS.CONVERSATION_INTRO_CALL_BOOKED]['context_type']
    >().toEqualTypeOf<'request_interaction' | 'project_call'>();

    const booked: ConversationEventMap[typeof CONVERSATION_EVENTS.CONVERSATION_INTRO_CALL_BOOKED] =
      {
        request_id: 'request-1',
        relationship_id: 'relationship-1',
        expert_profile_id: 'expert-1',
        surface: 'header',
        duration_minutes: 30,
        guest_count: 0,
        provisioned: true,
        context_type: 'project_call',
        request_status: 'kickoff_approved',
      };
    expect(Object.keys(booked).sort((a, b) => a.localeCompare(b))).toEqual([
      'context_type',
      'duration_minutes',
      'expert_profile_id',
      'guest_count',
      'provisioned',
      'relationship_id',
      'request_id',
      'request_status',
      'surface',
    ]);
  });
});
