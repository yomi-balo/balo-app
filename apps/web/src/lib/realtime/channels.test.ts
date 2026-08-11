import { describe, it, expect } from 'vitest';
import {
  conversationChannelName,
  CONVERSATION_EVENT_MESSAGE,
  CONVERSATION_EVENT_FILE,
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
