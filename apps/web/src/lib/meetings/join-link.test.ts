import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠ THE MODULE CARRIES `import 'server-only'` — `APP_URL` has no `NEXT_PUBLIC_` prefix, so in a
// client bundle Next would inline it as `undefined` and the builder would silently degrade to
// the production origin. The package throws outside an RSC graph, so the unit test stubs it.
vi.mock('server-only', () => ({}));

import { meetingJoinLinkUrl } from './join-link';

/**
 * BAL-436 — the "Copy join link" URL.
 *
 * ⚠⚠ THE ASSERTION THAT MATTERS IS **NO TOKEN**. The raw guest token never comes back from the
 * api and this UI never builds a link; whoever opens this lands in the pending lobby and must
 * be admitted by a host.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_PUBLIC_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_PUBLIC_APP_URL;
});

describe('meetingJoinLinkUrl', () => {
  it('builds the bare LOBBY url from APP_URL', () => {
    process.env.APP_URL = 'https://balo.example';

    expect(meetingJoinLinkUrl(MEETING_ID)).toBe(`https://balo.example/join/m/${MEETING_ID}`);
  });

  it('⚠⚠ carries NO token — it is the lobby route, not `/join/{token}`', () => {
    process.env.APP_URL = 'https://balo.example';
    const url = meetingJoinLinkUrl(MEETING_ID);

    // The mint's shape is 43 base64url chars; the stored form is 64 hex.
    expect(url).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(url).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(url.endsWith(MEETING_ID)).toBe(true);
  });

  it('falls back to NEXT_PUBLIC_APP_URL, then to the production origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://preview.example';
    expect(meetingJoinLinkUrl(MEETING_ID)).toBe(`https://preview.example/join/m/${MEETING_ID}`);

    delete process.env.NEXT_PUBLIC_APP_URL;
    // ⚠ THE SAME FALLBACK `apps/api`'s email templates use, so a copied link and an emailed one
    // cannot point at different origins.
    expect(meetingJoinLinkUrl(MEETING_ID)).toBe(`https://balo.expert/join/m/${MEETING_ID}`);
  });

  it('⚠ trims a trailing slash — a double slash resolves fine and looks broken in an inbox', () => {
    process.env.APP_URL = 'https://balo.example/';

    expect(meetingJoinLinkUrl(MEETING_ID)).toBe(`https://balo.example/join/m/${MEETING_ID}`);
  });
});
