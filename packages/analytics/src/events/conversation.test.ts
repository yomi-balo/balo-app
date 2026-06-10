import { describe, it, expect } from 'vitest';
import { CONVERSATION_EVENTS } from './conversation';

describe('CONVERSATION_EVENTS', () => {
  it('has exactly the five A4 events plus the A5 proposal CTA', () => {
    expect(Object.keys(CONVERSATION_EVENTS)).toEqual([
      'CONVERSATION_MESSAGE_SENT',
      'CONVERSATION_FILE_SHARED',
      'CONVERSATION_THREAD_SELECTED',
      'CONVERSATION_FILES_OPENED',
      'CONVERSATION_CALL_CTA_CLICKED',
      'CONVERSATION_PROPOSAL_CTA_CLICKED',
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
  });
});
