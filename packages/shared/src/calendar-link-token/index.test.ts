import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAddToCalendarToken, verifyAddToCalendarToken, type AddToCalendarEvent } from './index';

const SECRET = 'test-secret';
const EVENT: AddToCalendarEvent = {
  title: 'Consultation with Northwind, Inc.',
  startIso: '2026-11-17T22:00:00.000Z',
  endIso: '2026-11-17T23:00:00.000Z',
  details: 'CPQ rollout\n\nJoin: https://app.balo.expert/meetings/m-1/call',
  location: 'https://app.balo.expert/meetings/m-1/call',
};

/** A token whose payload is `wire`, correctly signed — to reach the payload validation. */
function signedRaw(wire: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(wire)).toString('base64url');
  const key = crypto.createHmac('sha256', SECRET).update('balo:add-to-calendar-link:v1').digest();
  return `${payloadB64}.${crypto.createHmac('sha256', key).update(payloadB64).digest('base64url')}`;
}

describe('add-to-calendar token', () => {
  it('round-trips an event with every field', () => {
    expect(verifyAddToCalendarToken(signAddToCalendarToken(EVENT, SECRET), SECRET)).toEqual(EVENT);
  });

  it('round-trips an event without details or location (the guest shape)', () => {
    const guest = { title: EVENT.title, startIso: EVENT.startIso, endIso: EVENT.endIso };
    expect(verifyAddToCalendarToken(signAddToCalendarToken(guest, SECRET), SECRET)).toEqual(guest);
  });

  it('is URL-path safe — no slash, query or fragment character', () => {
    expect(signAddToCalendarToken(EVENT, SECRET)).not.toMatch(/[/?#%]/);
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyAddToCalendarToken(signAddToCalendarToken(EVENT, 'other'), SECRET)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signAddToCalendarToken(EVENT, SECRET).split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: 'Pay now', s: EVENT.startIso, e: EVENT.endIso })
    ).toString('base64url');
    expect(verifyAddToCalendarToken(`${forged}.${sig ?? ''}`, SECRET)).toBeNull();
  });

  it('does not accept a signature made directly with the secret (key is purpose-derived)', () => {
    const payloadB64 = signAddToCalendarToken(EVENT, SECRET).split('.')[0] ?? '';
    const rawSig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    expect(verifyAddToCalendarToken(`${payloadB64}.${rawSig}`, SECRET)).toBeNull();
  });

  it.each(['', 'abc', 'a.b.c', 'x'.repeat(5000)])('rejects malformed token %#', (token) => {
    expect(verifyAddToCalendarToken(token, SECRET)).toBeNull();
  });

  it.each([
    ['an over-long title', { ...EVENT, title: 'x'.repeat(301) }],
    ['a non-https location', { ...EVENT, location: 'http://example.test/call' }],
    ['an end before the start', { ...EVENT, endIso: EVENT.startIso }],
  ])('refuses to sign %s (the limits verify enforces)', (_label, event) => {
    expect(() => signAddToCalendarToken(event, SECRET)).toThrow();
  });

  it('rejects everything when the secret is empty', () => {
    expect(verifyAddToCalendarToken(signAddToCalendarToken(EVENT, SECRET), '')).toBeNull();
    expect(() => signAddToCalendarToken(EVENT, '')).toThrow();
  });

  it.each([
    ['wrong version', { v: 2, t: 'x', s: EVENT.startIso, e: EVENT.endIso }],
    ['empty title', { v: 1, t: '', s: EVENT.startIso, e: EVENT.endIso }],
    ['bad start', { v: 1, t: 'x', s: 'not-a-date', e: EVENT.endIso }],
    ['end before start', { v: 1, t: 'x', s: EVENT.endIso, e: EVENT.startIso }],
    [
      'non-https location',
      { v: 1, t: 'x', s: EVENT.startIso, e: EVENT.endIso, l: 'javascript:alert(1)' },
    ],
    ['non-string details', { v: 1, t: 'x', s: EVENT.startIso, e: EVENT.endIso, d: 42 }],
    ['not an object', 'just a string'],
  ])('rejects a correctly signed but invalid payload: %s', (_label, wire) => {
    expect(verifyAddToCalendarToken(signedRaw(wire), SECRET)).toBeNull();
  });
});
