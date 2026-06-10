import { describe, it, expect } from 'vitest';
import {
  conversationChannelName,
  CONVERSATION_EVENT_MESSAGE,
  CONVERSATION_EVENT_FILE,
} from './channels';

describe('conversation realtime channels', () => {
  it('names the channel conversation:{relationshipId}', () => {
    expect(conversationChannelName('rel-1')).toBe('conversation:rel-1');
  });

  it('exposes the two event names the publisher/subscriber agree on', () => {
    expect(CONVERSATION_EVENT_MESSAGE).toBe('message');
    expect(CONVERSATION_EVENT_FILE).toBe('file');
  });
});
