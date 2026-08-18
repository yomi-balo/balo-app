import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApirocConfigError } from './errors.js';
import { toApirocProviderType, buildApirocAuthorizeUrl } from './oauth.js';

const ORIGINAL_ENV = { ...process.env };

describe('toApirocProviderType', () => {
  it('maps google → GOOGLE', () => {
    expect(toApirocProviderType('google')).toBe('GOOGLE');
  });

  it('maps microsoft → MICROSOFT', () => {
    expect(toApirocProviderType('microsoft')).toBe('MICROSOFT');
  });
});

describe('buildApirocAuthorizeUrl', () => {
  beforeEach(() => {
    process.env.APIROC_APP_ID = 'app-123';
    process.env.APIROC_REDIRECT_URI = 'https://api.balo.test/auth/apiroc/callback';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('builds a URL carrying redirectUrl, externalId and state', () => {
    const url = buildApirocAuthorizeUrl({
      provider: 'google',
      state: 'signed-state-value',
      externalId: 'expert-profile-1',
    });

    expect(url).toContain(encodeURIComponent('https://api.balo.test/auth/apiroc/callback'));
    expect(url).toContain('externalId=expert-profile-1');
    expect(url).toContain('state=signed-state-value');
  });

  it('throws ApirocConfigError when APIROC_APP_ID is missing', () => {
    delete process.env.APIROC_APP_ID;
    expect(() =>
      buildApirocAuthorizeUrl({ provider: 'google', state: 's', externalId: 'e' })
    ).toThrow(ApirocConfigError);
  });

  it('throws ApirocConfigError when APIROC_REDIRECT_URI is missing', () => {
    delete process.env.APIROC_REDIRECT_URI;
    expect(() =>
      buildApirocAuthorizeUrl({ provider: 'microsoft', state: 's', externalId: 'e' })
    ).toThrow(ApirocConfigError);
  });
});
