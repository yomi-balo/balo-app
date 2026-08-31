import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSiteOrigin } from './site-url';

describe('resolveSiteOrigin', () => {
  const originalAppUrl = process.env.APP_URL;
  const originalPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalPublicAppUrl;
  });

  it('prefers APP_URL', () => {
    process.env.APP_URL = 'https://staging.balo.expert';
    process.env.NEXT_PUBLIC_APP_URL = 'https://public.balo.expert';
    expect(resolveSiteOrigin()).toBe('https://staging.balo.expert');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://public.balo.expert';
    expect(resolveSiteOrigin()).toBe('https://public.balo.expert');
  });

  it('falls back to the production default when neither is set', () => {
    expect(resolveSiteOrigin()).toBe('https://balo.expert');
  });

  it('drops a single trailing slash', () => {
    process.env.APP_URL = 'https://balo.expert/';
    expect(resolveSiteOrigin()).toBe('https://balo.expert');
  });

  it('drops multiple trailing slashes', () => {
    process.env.APP_URL = 'https://balo.expert///';
    expect(resolveSiteOrigin()).toBe('https://balo.expert');
  });

  it('leaves a URL with no trailing slash untouched', () => {
    process.env.APP_URL = 'https://balo.expert';
    expect(resolveSiteOrigin()).toBe('https://balo.expert');
  });
});
