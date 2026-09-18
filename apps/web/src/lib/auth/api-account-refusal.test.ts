import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

let mockSessionObj: Record<string, unknown> | null;
vi.mock('./session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

const mockNoteAccountRefusal = vi.fn();
vi.mock('./account-liveness', () => ({
  noteAccountRefusal: (...args: unknown[]) => mockNoteAccountRefusal(...args),
}));

import { ACCOUNT_REFUSAL_HEADER } from '@balo/shared/authz';
import { log } from '@/lib/logging';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import {
  accountRefusalFromResponse,
  consumeApiAccountRefusal,
  noteApiAccountRefusal,
} from './api-account-refusal';

const responseWith = (headers: Record<string, string>): Response =>
  new Response('{"error":"Unauthorized"}', { status: 401, headers });

describe('accountRefusalFromResponse (BAL-568)', () => {
  it('reads the marker off a 401', () => {
    expect(
      accountRefusalFromResponse(responseWith({ [ACCOUNT_REFUSAL_HEADER]: 'account_suspended' }))
    ).toBe('account_suspended');
    expect(
      accountRefusalFromResponse(responseWith({ [ACCOUNT_REFUSAL_HEADER]: 'account_deleted' }))
    ).toBe('account_deleted');
  });

  /** `Headers.get` is case-insensitive per the Fetch spec — the wire casing must not matter. */
  it('⚠ reads the header case-INSENSITIVELY', () => {
    expect(
      accountRefusalFromResponse(responseWith({ 'X-Balo-Session-Invalid': 'account_suspended' }))
    ).toBe('account_suspended');
  });

  it('returns null when the header is absent — an ordinary 401 is unchanged', () => {
    expect(accountRefusalFromResponse(responseWith({}))).toBeNull();
  });

  it('⚠ fails CLOSED to null on an unknown value — never passes an arbitrary string through', () => {
    for (const value of ['', 'suspended', 'ACCOUNT_SUSPENDED', 'account_frobnicated']) {
      expect(
        accountRefusalFromResponse(responseWith({ [ACCOUNT_REFUSAL_HEADER]: value }))
      ).toBeNull();
    }
  });
});

describe('noteApiAccountRefusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: 'user-1' } };
  });

  it('logs and records the refusal on the api path', async () => {
    await noteApiAccountRefusal('account_suspended');

    expect(log.warn).toHaveBeenCalledWith('API refused a non-live account', {
      userId: 'user-1',
      reason: 'suspended',
    });
    expect(mockNoteAccountRefusal).toHaveBeenCalledWith('account_suspended', 'api', 'user-1');
  });

  it('maps account_deleted to the deleted reason', async () => {
    await noteApiAccountRefusal('account_deleted');
    expect(mockNoteAccountRefusal).toHaveBeenCalledWith('account_deleted', 'api', 'user-1');
  });

  it('⚠ logs but emits NO event when there is no session to attribute it to', async () => {
    mockSessionObj = {};

    await noteApiAccountRefusal('account_suspended');

    expect(log.warn).toHaveBeenCalledWith('API refused a non-live account', {
      reason: 'suspended',
    });
    expect(mockNoteAccountRefusal).not.toHaveBeenCalled();
  });
});

describe('consumeApiAccountRefusal — the ONE shape every web→api client uses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: 'user-1' } };
  });

  it('records and returns the code when the marker is present', async () => {
    const code = await consumeApiAccountRefusal(
      responseWith({ [ACCOUNT_REFUSAL_HEADER]: 'account_suspended' })
    );

    expect(code).toBe('account_suspended');
    expect(mockNoteAccountRefusal).toHaveBeenCalledTimes(1);
  });

  it('returns null and records NOTHING for an ordinary 401', async () => {
    const code = await consumeApiAccountRefusal(responseWith({}));

    expect(code).toBeNull();
    expect(mockNoteAccountRefusal).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE R2 HAZARD PIN, AND IT IS A SOURCE ASSERTION ON PURPOSE. Every behavioural case above
 * passes just as happily against a version that ALSO redirects or destroys the cookie; only
 * reading the source can see that neither was added.
 *
 *  · `redirect()` throws `NEXT_REDIRECT`, and every shipped caller of these clients wraps the
 *    call in its own `try/catch`, which would swallow it and render generic retry copy — a
 *    SILENT failure of the sign-out.
 *  · Destroying the cookie here would make the next render's `checkSessionDrift` see no session,
 *    so the sync route would redirect to a BARE `/login` and BAL-197's copy would be lost.
 */
describe('⚠ this module must never redirect, and must never destroy the cookie (R2)', () => {
  // ⚠ CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web`, so a
  // single cwd-relative path resolves to nothing in one of the two — and a read that finds
  // nothing would make every assertion below vacuous. `resolveRouteDir` is the repo's answer
  // (memory `reference_web_server_disk_asset_cwd`).
  const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);
  const SOURCE = codeLinesOf(
    readFileSync(path.join(SRC_DIR, 'lib/auth/api-account-refusal.ts'), 'utf8')
  );

  it('names neither redirect( nor destroy( in executable code', () => {
    expect(SRC_DIR).not.toBe('');
    expect(SOURCE.length).toBeGreaterThan(200);
    expect(SOURCE).not.toContain('redirect(');
    expect(SOURCE).not.toContain('destroy(');
    // And it genuinely is the module under test (a path typo would make the above vacuous).
    expect(SOURCE).toContain('export async function noteApiAccountRefusal');
  });
});
