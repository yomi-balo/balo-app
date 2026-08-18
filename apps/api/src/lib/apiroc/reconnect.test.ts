import { describe, it, expect } from 'vitest';
import { ApirocError } from './errors.js';
import { classifyCredentialFailure } from './reconnect.js';

function err(kind: ApirocError['kind'], wireMessage?: string): ApirocError {
  return new ApirocError({ kind, operation: 'calendars.list', wireMessage });
}

describe('classifyCredentialFailure (BAL-396 §10.4)', () => {
  it('401 + "Token has been expired or revoked." ⇒ reconnect_required (the ticket-mandatory pre-flip arm)', () => {
    const verdict = classifyCredentialFailure(
      err('unauthorized', 'Token has been expired or revoked.')
    );
    expect(verdict).toEqual({
      kind: 'reconnect_required',
      marker: 'Token has been expired or revoked.',
    });
  });

  it('401 with a DIFFERENT message ⇒ platform_auth_failure (the ticket-mandatory negative control)', () => {
    const verdict = classifyCredentialFailure(err('unauthorized', 'Invalid API key'));
    expect(verdict).toEqual({ kind: 'platform_auth_failure' });
  });

  it('401 with an ABSENT wireMessage ⇒ platform_auth_failure — the asymmetry rule, never the expert arm', () => {
    const verdict = classifyCredentialFailure(err('unauthorized', undefined));
    expect(verdict).toEqual({ kind: 'platform_auth_failure' });
  });

  it('403 + "End user account credential expired" ⇒ reconnect_required (post-flip)', () => {
    const verdict = classifyCredentialFailure(
      err('forbidden', 'End user account credential expired')
    );
    expect(verdict).toEqual({
      kind: 'reconnect_required',
      marker: 'End user account credential expired',
    });
  });

  it('403 + "Invalid refresh token" (getCredentials post-flip) ⇒ reconnect_required', () => {
    const verdict = classifyCredentialFailure(err('forbidden', 'Invalid refresh token'));
    expect(verdict).toEqual({ kind: 'reconnect_required', marker: 'Invalid refresh token' });
  });

  it('403 with no marker ⇒ other (log loudly, touch nothing) — never reconnect_required', () => {
    const verdict = classifyCredentialFailure(err('forbidden', 'Some unrelated 403'));
    expect(verdict).toEqual({ kind: 'other' });
  });

  it('403 with an absent wireMessage ⇒ other', () => {
    const verdict = classifyCredentialFailure(err('forbidden', undefined));
    expect(verdict).toEqual({ kind: 'other' });
  });

  it.each(['rate_limited', 'server_error', 'network'] as const)(
    '%s ⇒ transient regardless of wireMessage',
    (kind) => {
      expect(classifyCredentialFailure(err(kind, 'Token has been expired or revoked.'))).toEqual({
        kind: 'transient',
      });
    }
  );

  it.each(['validation', 'not_found', 'unknown'] as const)(
    '%s ⇒ other regardless of wireMessage',
    (kind) => {
      expect(classifyCredentialFailure(err(kind, 'Token has been expired or revoked.'))).toEqual({
        kind: 'other',
      });
    }
  );

  it('marker matching is case-insensitive', () => {
    const verdict = classifyCredentialFailure(
      err('unauthorized', 'TOKEN HAS BEEN EXPIRED OR REVOKED.')
    );
    expect(verdict.kind).toBe('reconnect_required');
  });

  it('never reads wireErrorRaw as evidence — a matching wireErrorRaw with no wireMessage still fails to the platform arm', () => {
    const withRaw = new ApirocError({
      kind: 'unauthorized',
      operation: 'calendars.list',
      wireErrorRaw: { error: 'InvalidRefreshToken' },
    });
    expect(classifyCredentialFailure(withRaw)).toEqual({ kind: 'platform_auth_failure' });
  });
});
