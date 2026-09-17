import { describe, expect, it } from 'vitest';
import { escapeIcsText } from './ics-text';

describe('escapeIcsText', () => {
  it('doubles the backslash FIRST, before any other escape is introduced', () => {
    expect(escapeIcsText('A\\B;C,D')).toBe('A\\\\B\\;C\\,D');
  });

  it('collapses CR, LF and CRLF each to the two-character sequence \\n', () => {
    expect(escapeIcsText('a\rb')).toBe('a\\nb');
    expect(escapeIcsText('a\nb')).toBe('a\\nb');
    expect(escapeIcsText('a\r\nb')).toBe('a\\nb');
  });

  it('collapses a run of CR/LF (e.g. \\r\\r\\n) into one \\n per matched break', () => {
    expect(escapeIcsText('a\r\r\nb')).toBe('a\\n\\nb');
  });

  it('escapes semicolons and commas', () => {
    expect(escapeIcsText('a;b,c')).toBe('a\\;b\\,c');
  });

  it('BAL-283 regression vector: a raw CRLF-injected ATTENDEE line collapses to one escaped line with no CR/LF left', () => {
    const vector = 'Dana\r\nATTENDEE;CN=Dana:mailto:attacker@evil.com';
    const escaped = escapeIcsText(vector);

    expect(escaped).not.toContain('\r');
    expect(escaped).not.toContain('\n');
    expect(escaped).toBe('Dana\\nATTENDEE\\;CN=Dana:mailto:attacker@evil.com');
  });
});
