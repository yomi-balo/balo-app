import { describe, expect, it } from 'vitest';
import { CALL_TOAST_EVENTS, isCallToastEvent } from './call-toast-events';

describe('call toast events', () => {
  it('lists exactly the ringing and missed-call events', () => {
    expect(CALL_TOAST_EVENTS).toEqual(['call.ringing', 'call.no_answer']);
  });

  it.each(['call.ringing', 'call.no_answer'])('%s is a call toast event', (event) => {
    expect(isCallToastEvent(event)).toBe(true);
  });

  it.each(['call.connected', 'call.declined', 'conversation.message', ''])(
    '%s is not a call toast event',
    (event) => {
      expect(isCallToastEvent(event)).toBe(false);
    }
  );
});
