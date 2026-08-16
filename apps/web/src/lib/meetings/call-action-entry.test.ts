import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  INVALID_REQUEST_ERROR,
  NOT_SIGNED_IN_ERROR,
  callActionErrorFields,
  enterCallAction,
} from './call-action-entry';

/**
 * BAL-437 — the entry preamble shared by the four in-call Server Actions.
 *
 * ⚠⚠ THE ORDERING IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. Auth runs BEFORE validation,
 * so an unauthenticated caller learns nothing about the schema. Each action's "no gate call was
 * made" test leans on that, asserting the auth refusal alone — so it is pinned here directly
 * with an input that would ALSO fail the schema.
 */

const schema = z.object({ meetingId: z.string().min(1) });

describe('enterCallAction — authenticate, then validate', () => {
  it('returns the narrowed user and parsed data when both succeed', async () => {
    const user = { id: 'user_1' };
    const result = await enterCallAction(() => Promise.resolve(user), schema, {
      meetingId: 'meeting_1',
    });

    expect(result.ok).toBe(true);
    // Narrowing, so the success fields are reachable without a cast.
    if (!result.ok) throw new Error('expected ok');
    expect(result.user).toBe(user);
    expect(result.data).toEqual({ meetingId: 'meeting_1' });
  });

  it('refuses with the shipped NOT_SIGNED_IN literal when the auth helper throws', async () => {
    const result = await enterCallAction(() => Promise.reject(new Error('no session')), schema, {
      meetingId: 'meeting_1',
    });

    expect(result).toEqual({ ok: false, error: NOT_SIGNED_IN_ERROR });
    expect(NOT_SIGNED_IN_ERROR).toBe('You are not signed in.');
  });

  it('refuses with the shipped INVALID_REQUEST literal when the schema rejects', async () => {
    const result = await enterCallAction(() => Promise.resolve({ id: 'user_1' }), schema, {
      meetingId: '',
    });

    expect(result).toEqual({ ok: false, error: INVALID_REQUEST_ERROR });
    expect(INVALID_REQUEST_ERROR).toBe('Invalid request.');
  });

  it('⚠ AUTH WINS OVER VALIDATION: bad auth AND bad input yields the auth refusal only', async () => {
    const parse = vi.spyOn(schema, 'safeParse');

    const result = await enterCallAction(
      () => Promise.reject(new Error('no session')),
      schema,
      { meetingId: '' } // would also fail the schema
    );

    expect(result).toEqual({ ok: false, error: NOT_SIGNED_IN_ERROR });
    // The schema was never consulted — an unauthenticated caller learns nothing about it.
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('does not call the auth helper more than once', async () => {
    const authenticate = vi.fn(() => Promise.resolve({ id: 'user_1' }));

    await enterCallAction(authenticate, schema, { meetingId: 'meeting_1' });

    expect(authenticate).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⚠ `callActionErrorFields` NARROWS IN PLACE rather than importing `errorMessage` from
 * `@/lib/logging` — see the module docblock. That makes its non-`Error` branches this module's
 * own responsibility, so each is exercised below rather than assumed.
 */
describe('callActionErrorFields', () => {
  it('takes message and stack from a real Error', () => {
    const error = new Error('boom');

    const fields = callActionErrorFields(error);

    expect(fields.error).toBe('boom');
    expect(fields.stack).toBe(error.stack);
    expect(fields.stack).toContain('Error: boom');
  });

  it('passes a thrown string through with no stack', () => {
    expect(callActionErrorFields('plain failure')).toEqual({
      error: 'plain failure',
      stack: undefined,
    });
  });

  it('serialises a thrown plain object so the context is not lost', () => {
    expect(callActionErrorFields({ code: 'E_LIMIT', retryable: false })).toEqual({
      error: '{"code":"E_LIMIT","retryable":false}',
      stack: undefined,
    });
  });

  it('falls back to Unknown error when JSON.stringify returns undefined', () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string — the `??` arm.
    expect(callActionErrorFields(undefined)).toEqual({
      error: 'Unknown error',
      stack: undefined,
    });
  });

  it('falls back to Unknown error when JSON.stringify THROWS on a circular value', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(callActionErrorFields(circular)).toEqual({
      error: 'Unknown error',
      stack: undefined,
    });
  });

  it('falls back to Unknown error when JSON.stringify throws on a BigInt', () => {
    expect(callActionErrorFields(10n)).toEqual({
      error: 'Unknown error',
      stack: undefined,
    });
  });
});
