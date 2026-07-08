import { describe, it, expect } from 'vitest';
import { mapWorkosAuthMethod } from './auth-method';

/**
 * Unit truth-table for the WorkOS → Balo auth-method mapper (BAL-350). Pure,
 * mocks nothing. Only the two OAuth providers map to a signal; everything else
 * (including the OTP-relevant Password/MagicAuth and unknown/undefined) maps to
 * `undefined` so analytics never mislabels the auth method.
 */
describe('mapWorkosAuthMethod', () => {
  it('maps GoogleOAuth → oauth_google', () => {
    expect(mapWorkosAuthMethod('GoogleOAuth')).toBe('oauth_google');
  });

  it('maps MicrosoftOAuth → oauth_microsoft', () => {
    expect(mapWorkosAuthMethod('MicrosoftOAuth')).toBe('oauth_microsoft');
  });

  it('returns undefined for Password', () => {
    expect(mapWorkosAuthMethod('Password')).toBeUndefined();
  });

  it('returns undefined for MagicAuth', () => {
    expect(mapWorkosAuthMethod('MagicAuth')).toBeUndefined();
  });

  it('returns undefined for an unknown method', () => {
    expect(mapWorkosAuthMethod('SSO')).toBeUndefined();
    expect(mapWorkosAuthMethod('Passkey')).toBeUndefined();
    expect(mapWorkosAuthMethod('something-else')).toBeUndefined();
  });

  it('returns undefined when the method is undefined', () => {
    expect(mapWorkosAuthMethod(undefined)).toBeUndefined();
    expect(mapWorkosAuthMethod()).toBeUndefined();
  });
});
