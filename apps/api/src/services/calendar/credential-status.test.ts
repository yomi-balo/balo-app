import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSetCredentialStatus,
  mockClearAvailabilityCache,
  mockMarkReconnectNotified,
  mockEndUserAccountsGet,
  mockPublish,
  mockTrackServer,
  mockLog,
} = vi.hoisted(() => ({
  mockSetCredentialStatus: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
  mockMarkReconnectNotified: vi.fn(),
  mockEndUserAccountsGet: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    setCredentialStatus: mockSetCredentialStatus,
    clearAvailabilityCache: mockClearAvailabilityCache,
    markReconnectNotified: mockMarkReconnectNotified,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: { CREDENTIALS_REVOKED: 'calendar_credentials_revoked' },
  toCalendarEventProvider: (p: string) => (p === 'google' || p === 'microsoft' ? p : undefined),
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({ endUserAccounts: { get: mockEndUserAccountsGet } }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
  classifyCredentialFailure: (err: { kind: string; wireMessage?: string }) => {
    if (err.kind === 'unauthorized' && err.wireMessage === 'Token has been expired or revoked.') {
      return { kind: 'reconnect_required', marker: err.wireMessage };
    }
    if (err.kind === 'unauthorized') return { kind: 'platform_auth_failure' };
    if (err.kind === 'forbidden' && err.wireMessage === 'End user account credential expired') {
      return { kind: 'reconnect_required', marker: err.wireMessage };
    }
    if (err.kind === 'server_error') return { kind: 'transient' };
    return { kind: 'other' };
  },
}));

vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

const { applyCredentialFailure } = await import('./credential-status.js');

import type { CalendarConnection } from '@balo/db';
import { ApirocError, type ApirocFailureKind } from '../../lib/apiroc/errors.js';

function mkErr(kind: ApirocFailureKind, wireMessage?: string): ApirocError {
  return new ApirocError({ kind, operation: 'calendars.list', wireMessage });
}

function buildConnection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn-1',
    expertProfileId: 'expert-1',
    provider: 'google',
    endUserAccountId: 'eua-1',
    providerEmail: null,
    targetCalendarId: null,
    credentialStatus: 'EXPIRED',
    reconnectNotifiedAt: null,
    credentialCheckedAt: null,
    lastSyncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('applyCredentialFailure (BAL-396 §10.4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reconnect_required + re-read still ACTIVE ⇒ persists EXPIRED (the status lags)', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'ACTIVE' });

    const verdict = await applyCredentialFailure(
      buildConnection(),
      mkErr('unauthorized', 'Token has been expired or revoked.'),
      'health_probe'
    );

    expect(verdict.kind).toBe('reconnect_required');
    expect(mockSetCredentialStatus).toHaveBeenCalledWith('conn-1', 'EXPIRED');
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith('expert-1');
  });

  it('reconnect_required + re-read says REVOKED ⇒ persists REVOKED', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'REVOKED' });

    await applyCredentialFailure(
      buildConnection(),
      mkErr('forbidden', 'End user account credential expired'),
      'health_probe'
    );

    expect(mockSetCredentialStatus).toHaveBeenCalledWith('conn-1', 'REVOKED');
  });

  it('a failed confirmation re-read still flips to EXPIRED — never aborts the flip', async () => {
    mockEndUserAccountsGet.mockRejectedValue(new Error('vendor 500'));

    const verdict = await applyCredentialFailure(
      buildConnection(),
      mkErr('unauthorized', 'Token has been expired or revoked.'),
      'health_probe'
    );

    expect(verdict.kind).toBe('reconnect_required');
    expect(mockSetCredentialStatus).toHaveBeenCalledWith('conn-1', 'EXPIRED');
  });

  it('publishes calendar.auth_error with provider, then marks notified — only when not yet notified', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'EXPIRED' });

    await applyCredentialFailure(
      buildConnection({ reconnectNotifiedAt: null }),
      mkErr('unauthorized', 'Token has been expired or revoked.'),
      'health_probe'
    );

    expect(mockPublish).toHaveBeenCalledWith('calendar.auth_error', {
      correlationId: 'conn-1',
      expertProfileId: 'expert-1',
      provider: 'google',
    });
    expect(mockMarkReconnectNotified).toHaveBeenCalledWith('conn-1', expect.any(Date));
  });

  it('does NOT publish a second time when already notified for this breakage', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'EXPIRED' });

    await applyCredentialFailure(
      buildConnection({ reconnectNotifiedAt: new Date('2026-08-01T00:00:00Z') }),
      mkErr('unauthorized', 'Token has been expired or revoked.'),
      'health_probe'
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkReconnectNotified).not.toHaveBeenCalled();
  });

  it('tracks CREDENTIALS_REVOKED with detected_by and the narrowed provider', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'EXPIRED' });

    await applyCredentialFailure(
      buildConnection({ provider: 'microsoft' }),
      mkErr('unauthorized', 'Token has been expired or revoked.'),
      'health_probe'
    );

    expect(mockTrackServer).toHaveBeenCalledWith('calendar_credentials_revoked', {
      provider: 'microsoft',
      detected_by: 'health_probe',
      distinct_id: 'expert-1',
    });
  });

  it('platform_auth_failure flips nothing and notifies nobody', async () => {
    const verdict = await applyCredentialFailure(
      buildConnection(),
      mkErr('unauthorized', 'bad api key'),
      'health_probe'
    );

    expect(verdict).toEqual({ kind: 'platform_auth_failure' });
    expect(mockSetCredentialStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('transient/other leave the row alone and only log a warning', async () => {
    const verdict = await applyCredentialFailure(
      buildConnection(),
      mkErr('server_error'),
      'health_probe'
    );

    expect(verdict).toEqual({ kind: 'transient' });
    expect(mockSetCredentialStatus).not.toHaveBeenCalled();
    expect(mockClearAvailabilityCache).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  // ⚠ round-2 fix #9 — `flipToReconnectRequired` used to mark a credential dead with NO log
  // line at all. `apiroc_credential_reconnect_required` is the structured, always-on record
  // (unlike the PostHog track call, a no-op without POSTHOG_API_KEY, and the notification
  // publish, best-effort and swallowed on failure).
  it('logs apiroc_credential_reconnect_required with the connection, expert, resolved status and detectedBy', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'REVOKED' });

    await applyCredentialFailure(
      buildConnection({ provider: 'microsoft' }),
      mkErr('forbidden', 'End user account credential expired'),
      'health_probe'
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      {
        connectionId: 'conn-1',
        expertProfileId: 'expert-1',
        provider: 'microsoft',
        status: 'REVOKED',
        detectedBy: 'health_probe',
      },
      'apiroc_credential_reconnect_required'
    );
  });

  it('a publish failure is caught and logged, and does not throw', async () => {
    mockEndUserAccountsGet.mockResolvedValue({ status: 'EXPIRED' });
    mockPublish.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      applyCredentialFailure(
        buildConnection(),
        mkErr('unauthorized', 'Token has been expired or revoked.'),
        'health_probe'
      )
    ).resolves.toBeDefined();

    expect(mockLog.error).toHaveBeenCalled();
  });
});
