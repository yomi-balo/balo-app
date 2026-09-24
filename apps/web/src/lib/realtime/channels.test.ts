import { describe, it, expect } from 'vitest';
import {
  conversationChannelName,
  CONVERSATION_EVENT_MESSAGE,
  CONVERSATION_EVENT_FILE,
  isTypingChannelName,
  typingChannelName,
  TYPING_EVENT_STARTED,
  TYPING_EVENT_STOPPED,
  TYPING_SIGNALS,
  typingEventNameFor,
  typingSignalFromEventName,
} from './channels';

describe('conversation realtime channels', () => {
  /**
   * ⚠ BAL-424: the channel keys on `conversations.id`, NOT on the relationship. The
   * conversation id is the thread identity across every anchor — a Case has no relationship
   * at all, and a project thread that carries over at kickoff must keep ONE channel for life.
   */
  it('names the channel conversation:{conversationId}', () => {
    expect(conversationChannelName('conv-1')).toBe('conversation:conv-1');
  });

  it('exposes the two event names the publisher/subscriber agree on', () => {
    expect(CONVERSATION_EVENT_MESSAGE).toBe('message');
    expect(CONVERSATION_EVENT_FILE).toBe('file');
  });
});

describe('typing realtime channel', () => {
  it('names the channel typing:{conversationId}', () => {
    expect(typingChannelName('conv-1')).toBe('typing:conv-1');
  });

  /**
   * ⚠⚠ THE WHOLE NAMESPACE POINT. Ably matches a capability or channel rule up to the FIRST
   * colon, so anything starting `conversation:` — `conversation:{id}:typing` included — would
   * share the durable message stream's namespace and inherit its rules.
   */
  it('⚠⚠ does NOT sit in the conversation namespace', () => {
    const name = typingChannelName('conv-1');

    expect(name.startsWith('conversation:')).toBe(false);
    expect(name.split(':')[0]).toBe('typing');
  });

  it('recognises its own names, and only names whose FIRST segment is exactly `typing`', () => {
    expect(isTypingChannelName(typingChannelName('conv-1'))).toBe(true);
    expect(isTypingChannelName('typing:abc')).toBe(true);

    expect(isTypingChannelName('conversation:x')).toBe(false);
    expect(isTypingChannelName('conversation:x:typing')).toBe(false);
    expect(isTypingChannelName('meeting:x')).toBe(false);
    expect(isTypingChannelName('typingx:y')).toBe(false);
    expect(isTypingChannelName('typing')).toBe(false);
    expect(isTypingChannelName('xtyping:y')).toBe(false);
    expect(isTypingChannelName('')).toBe(false);
  });

  it('exposes the two payload-free event names the sender/receiver agree on', () => {
    expect(TYPING_EVENT_STARTED).toBe('typing.started');
    expect(TYPING_EVENT_STOPPED).toBe('typing.stopped');
  });

  it('the signal set is closed: exactly `started` and `stopped`', () => {
    expect(TYPING_SIGNALS).toEqual(['started', 'stopped']);
  });

  it('maps each signal to its wire name and back, and nothing else to a signal', () => {
    expect(typingEventNameFor('started')).toBe(TYPING_EVENT_STARTED);
    expect(typingEventNameFor('stopped')).toBe(TYPING_EVENT_STOPPED);
    for (const signal of TYPING_SIGNALS) {
      expect(typingSignalFromEventName(typingEventNameFor(signal))).toBe(signal);
    }
    for (const other of ['message', 'file', 'typing', 'started', '', undefined, null, 1]) {
      expect(typingSignalFromEventName(other)).toBeNull();
    }
  });
});
