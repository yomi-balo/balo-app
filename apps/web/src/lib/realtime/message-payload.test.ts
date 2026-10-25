import { describe, it, expect } from 'vitest';
import { isConversationFileSharedPayload } from './message-payload';

const VALID = {
  conversationId: 'conv-1',
  messageId: 'msg-1',
  senderUserId: 'user-1',
  createdAtIso: '2026-10-26T00:00:00.000Z',
};

describe('isConversationFileSharedPayload', () => {
  it('accepts the four-field content-free ping', () => {
    expect(isConversationFileSharedPayload(VALID)).toBe(true);
  });

  it.each(Object.keys(VALID))('rejects a payload missing %s', (key) => {
    const rest = Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));
    expect(isConversationFileSharedPayload(rest)).toBe(false);
  });

  it('rejects a non-string field', () => {
    expect(isConversationFileSharedPayload({ ...VALID, messageId: 7 })).toBe(false);
  });

  it.each([null, undefined, 'x', 3, []])('rejects %s', (data) => {
    expect(isConversationFileSharedPayload(data)).toBe(false);
  });
});
