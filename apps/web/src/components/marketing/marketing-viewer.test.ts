import { describe, it, expect, afterEach, vi } from 'vitest';
import { toMarketingViewer, type MarketingViewerSource } from './marketing-viewer';

function makeSource(overrides: Partial<MarketingViewerSource> = {}): MarketingViewerSource {
  return {
    firstName: null,
    lastName: null,
    email: 'user@example.com',
    avatarUrl: null,
    ...overrides,
  };
}

describe('toMarketingViewer', () => {
  it('returns null for a null user', () => {
    expect(toMarketingViewer(null)).toBeNull();
  });

  it('combines first and last name', () => {
    const viewer = toMarketingViewer(makeSource({ firstName: 'Dana', lastName: 'Okafor' }));
    expect(viewer?.displayName).toBe('Dana Okafor');
    expect(viewer?.initials).toBe('DO');
  });

  it('falls back to first name only', () => {
    const viewer = toMarketingViewer(makeSource({ firstName: 'Dana', lastName: null }));
    expect(viewer?.displayName).toBe('Dana');
    expect(viewer?.initials).toBe('D');
  });

  it('falls back to last name only', () => {
    const viewer = toMarketingViewer(makeSource({ firstName: null, lastName: 'Okafor' }));
    expect(viewer?.displayName).toBe('Okafor');
    expect(viewer?.initials).toBe('O');
  });

  it('falls back to the email local-part when both name fields are null', () => {
    const viewer = toMarketingViewer(
      makeSource({ firstName: null, lastName: null, email: 'sam@northwind.example' })
    );
    expect(viewer?.displayName).toBe('sam');
    expect(viewer?.initials).toBe('S');
  });

  it('falls back to "User" when the email has no local part', () => {
    const viewer = toMarketingViewer(makeSource({ firstName: null, lastName: null, email: '@x' }));
    expect(viewer?.displayName).toBe('User');
    expect(viewer?.initials).toBe('U');
  });

  it('returns exactly the three-field key set — the boundary regression guard', () => {
    const viewer = toMarketingViewer(makeSource({ firstName: 'Dana', lastName: 'Okafor' }));
    expect(Object.keys(viewer ?? {}).sort()).toEqual(['avatarUrl', 'displayName', 'initials']);
  });

  describe('avatarUrl', () => {
    const originalCdnUrl = process.env.NEXT_PUBLIC_CDN_URL;

    afterEach(() => {
      if (originalCdnUrl === undefined) {
        delete process.env.NEXT_PUBLIC_CDN_URL;
      } else {
        process.env.NEXT_PUBLIC_CDN_URL = originalCdnUrl;
      }
    });

    it('passes an already-full URL through', () => {
      const viewer = toMarketingViewer(makeSource({ avatarUrl: 'https://cdn.example.com/a.png' }));
      expect(viewer?.avatarUrl).toBe('https://cdn.example.com/a.png');
    });

    it('returns null when the user has no avatar', () => {
      const viewer = toMarketingViewer(makeSource({ avatarUrl: null }));
      expect(viewer?.avatarUrl).toBeNull();
    });

    // `getAvatarUrl` reads `NEXT_PUBLIC_CDN_URL` into a module-level const at import time, so
    // this case needs a fresh module instance (via `vi.resetModules`) rather than a runtime
    // env mutation, which the already-imported module would never observe.
    it('returns null for an R2 key when NEXT_PUBLIC_CDN_URL is unset', async () => {
      delete process.env.NEXT_PUBLIC_CDN_URL;
      vi.resetModules();
      const fresh = await import('./marketing-viewer');
      const viewer = fresh.toMarketingViewer(makeSource({ avatarUrl: 'users/abc/avatar.jpg' }));
      expect(viewer?.avatarUrl).toBeNull();
    });
  });
});
