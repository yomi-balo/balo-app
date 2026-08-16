import { describe, expect, it } from 'vitest';
import {
  MEETING_REACTIONS,
  isMeetingReactionEmoji,
  isMeetingReactionPayload,
} from './meeting-reactions';

/**
 * BAL-437 — the reaction vocabulary and its inbound structural guard.
 *
 * ⚠⚠ THE ABSENCE OF 👎 AND 😢 IS AN **ACCEPTANCE CRITERION**, not a preference, so it is
 * asserted rather than left to the array literal. This is a paid consultation between a client
 * and an expert; a one-tap anonymous downvote floating over somebody's face is a product
 * decision nobody made.
 */

describe('MEETING_REACTIONS — the closed set', () => {
  it('is exactly the six, in picker order', () => {
    expect([...MEETING_REACTIONS]).toEqual(['👍', '👏', '❤️', '🎉', '😂', '😮']);
  });

  it('⚠⚠ contains NO 👎 and NO 😢 — an acceptance criterion', () => {
    const members: readonly string[] = MEETING_REACTIONS;
    expect(members).not.toContain('👎');
    expect(members).not.toContain('😢');
  });

  it('has no duplicates — a repeated glyph would render two identical picker buttons', () => {
    expect(new Set(MEETING_REACTIONS).size).toBe(MEETING_REACTIONS.length);
  });
});

describe('isMeetingReactionEmoji', () => {
  it.each([...MEETING_REACTIONS])('accepts %s', (emoji) => {
    expect(isMeetingReactionEmoji(emoji)).toBe(true);
  });

  it.each([['👎'], ['😢'], ['🙂'], [''], ['👍👍']])('rejects %s', (value) => {
    expect(isMeetingReactionEmoji(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [['👍']]])('rejects the non-string %s', (value) => {
    expect(isMeetingReactionEmoji(value)).toBe(false);
  });
});

describe('isMeetingReactionPayload — ⚠ the THIRD-PARTY trust boundary', () => {
  const NONCE = 'a1b2c3d4-0000-4000-8000-000000000001';

  it('accepts a well-formed payload', () => {
    expect(isMeetingReactionPayload({ emoji: '🎉', nonce: NONCE })).toBe(true);
  });

  it('⚠ REJECTS A NON-MEMBER GLYPH — this is what stops arbitrary text over live video', () => {
    expect(isMeetingReactionPayload({ emoji: '💀', nonce: NONCE })).toBe(false);
    expect(isMeetingReactionPayload({ emoji: '<script>', nonce: NONCE })).toBe(false);
  });

  it('rejects a non-string nonce', () => {
    expect(isMeetingReactionPayload({ emoji: '👍', nonce: 7 })).toBe(false);
    expect(isMeetingReactionPayload({ emoji: '👍', nonce: null })).toBe(false);
  });

  it('rejects null, undefined and primitives', () => {
    expect(isMeetingReactionPayload(null)).toBe(false);
    expect(isMeetingReactionPayload(undefined)).toBe(false);
    expect(isMeetingReactionPayload('👍')).toBe(false);
  });

  it('⚠ REJECTS AN ARRAY — an array IS an object in JavaScript, so it is checked explicitly', () => {
    expect(isMeetingReactionPayload(['👍', NONCE])).toBe(false);
    expect(isMeetingReactionPayload([])).toBe(false);
  });

  it('⚠⚠ REJECTS A MEMBER WITH EXTRA KEYS — the only legitimate publisher emits exactly two', () => {
    expect(isMeetingReactionPayload({ emoji: '👍', nonce: NONCE, senderUserId: 'u1' })).toBe(false);
  });

  it('rejects a payload missing either key', () => {
    expect(isMeetingReactionPayload({ emoji: '👍' })).toBe(false);
    expect(isMeetingReactionPayload({ nonce: NONCE })).toBe(false);
  });
});
