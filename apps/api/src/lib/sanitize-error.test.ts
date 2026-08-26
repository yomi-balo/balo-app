import { describe, expect, it } from 'vitest';
import Mux from '@mux/mux-node';
import { sanitizedErrorMessage } from './sanitize-error.js';

const SIGNED_URL = 'https://daily-download.example/rec-abc?sig=SECRET_TOKEN&exp=123';

describe('sanitizedErrorMessage (BAL-473 fix round 1, F4)', () => {
  it('⚠⚠ a Mux APIError whose body echoes the signed URL never leaks it — closed `${status} ${type}` shape', () => {
    const error = Mux.APIError.generate(
      422,
      { type: 'invalid_parameters', messages: [`inputs[0].url is invalid: ${SIGNED_URL}`] },
      undefined,
      new Headers()
    );

    const message = sanitizedErrorMessage(error);

    expect(message).toBe('422 invalid_parameters');
    expect(message).not.toContain(SIGNED_URL);
    expect(message).not.toContain('SECRET_TOKEN');
  });

  it('falls back to "error" when the Mux body carries no `type`', () => {
    const error = Mux.APIError.generate(500, { messages: ['boom'] }, undefined, new Headers());

    expect(sanitizedErrorMessage(error)).toBe('500 error');
  });

  it('redacts a URL-shaped substring in a generic Error message (the backstop)', () => {
    const error = new Error(`upload rejected: ${SIGNED_URL} is not reachable`);

    const message = sanitizedErrorMessage(error);

    expect(message).not.toContain(SIGNED_URL);
    expect(message).not.toContain('SECRET_TOKEN');
    expect(message).toBe('upload rejected: [redacted-url] is not reachable');
  });

  it('passes through a plain message with no URL unchanged', () => {
    expect(sanitizedErrorMessage(new Error('daily_recording_id has no source'))).toBe(
      'daily_recording_id has no source'
    );
  });

  it('stringifies a non-Error throw', () => {
    expect(sanitizedErrorMessage('a string throw')).toBe('a string throw');
  });
});
