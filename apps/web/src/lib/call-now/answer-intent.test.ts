import { beforeEach, describe, expect, it } from 'vitest';
import { ANSWER_INTENT_TTL_MS, markAnswerIntent, takeAnswerIntent } from './answer-intent';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

describe('answer intent', () => {
  it('returns the ring id for the matching meeting, once', () => {
    markAnswerIntent({ meetingId: 'm-1', ringId: 'r-1' }, 1_000);
    expect(takeAnswerIntent('m-1', 2_000)).toBe('r-1');
    expect(takeAnswerIntent('m-1', 2_000)).toBeNull();
  });

  it('is consumed by a take for another meeting, which gets nothing', () => {
    markAnswerIntent({ meetingId: 'm-1', ringId: 'r-1' }, 1_000);
    expect(takeAnswerIntent('m-2', 2_000)).toBeNull();
    expect(takeAnswerIntent('m-1', 2_000)).toBeNull();
  });

  it('holds for the TTL and not a moment past it', () => {
    markAnswerIntent({ meetingId: 'm-1', ringId: 'r-1' }, 0);
    expect(takeAnswerIntent('m-1', ANSWER_INTENT_TTL_MS)).toBe('r-1');
    markAnswerIntent({ meetingId: 'm-1', ringId: 'r-1' }, 0);
    expect(takeAnswerIntent('m-1', ANSWER_INTENT_TTL_MS + 1)).toBeNull();
  });

  it('treats a malformed stored value as no intent', () => {
    store.set('balo.callNow.answerIntent', '{"meetingId":1}');
    expect(takeAnswerIntent('m-1')).toBeNull();
    store.set('balo.callNow.answerIntent', 'not json');
    expect(takeAnswerIntent('m-1')).toBeNull();
  });

  it('returns null, never throws, when storage fails', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    expect(() => markAnswerIntent({ meetingId: 'm-1', ringId: 'r-1' })).not.toThrow();
    expect(takeAnswerIntent('m-1')).toBeNull();
  });
});
