import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindConnectionByExpertProfileId,
  mockUpdateConnectionTokens,
  mockUpdateConnectionStatus,
  mockClearAvailabilityCache,
  mockGetCronofyAppClient,
  mockEncryptCalendarToken,
  mockDecryptCalendarToken,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockFindConnectionByExpertProfileId: vi.fn(),
  mockUpdateConnectionTokens: vi.fn(),
  mockUpdateConnectionStatus: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
  mockGetCronofyAppClient: vi.fn(),
  mockEncryptCalendarToken: vi.fn(),
  mockDecryptCalendarToken: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    findConnectionByExpertProfileId: mockFindConnectionByExpertProfileId,
    updateConnectionTokens: mockUpdateConnectionTokens,
    updateConnectionStatus: mockUpdateConnectionStatus,
    clearAvailabilityCache: mockClearAvailabilityCache,
  },
}));

vi.mock('../../lib/cronofy.js', () => ({
  getCronofyAppClient: mockGetCronofyAppClient,
}));

vi.mock('../../lib/calendar-encryption.js', () => ({
  encryptCalendarToken: mockEncryptCalendarToken,
  decryptCalendarToken: mockDecryptCalendarToken,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: {
    TOKEN_REFRESHED: 'calendar_token_refreshed',
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getValidAccessToken, forceRefreshToken } from './token-manager';
import { CalendarNotConnectedError, CalendarAuthError } from './errors';

// ── Test data ──────────────────────────────────────────────────

const EXPERT_ID = 'expert-profile-123';

const makeConnection = (
  overrides: Partial<{
    tokenExpiresAt: Date;
    accessToken: string;
    refreshToken: string;
    provider: string;
  }> = {}
) => ({
  id: 'conn-1',
  expertProfileId: EXPERT_ID,
  provider: 'google',
  accessToken: 'encrypted-access',
  refreshToken: 'encrypted-refresh',
  tokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h from now
  status: 'connected',
  ...overrides,
});

describe('token-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRONOFY_CLIENT_ID = 'test-client-id';
    process.env.CRONOFY_CLIENT_SECRET = 'test-client-secret';
    mockEncryptCalendarToken.mockImplementation((val: string) => `encrypted_${val}`);
    mockDecryptCalendarToken.mockImplementation((val: string) => val.replace('encrypted_', ''));
  });

  afterEach(() => {
    delete process.env.CRONOFY_CLIENT_ID;
    delete process.env.CRONOFY_CLIENT_SECRET;
  });

  describe('getValidAccessToken', () => {
    it('throws CalendarNotConnectedError when no connection found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('returns decrypted token when token is still fresh (> 1 hour)', async () => {
      const connection = makeConnection();
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);
      mockDecryptCalendarToken.mockReturnValue('decrypted-access-token');

      const result = await getValidAccessToken(EXPERT_ID);

      expect(result).toBe('decrypted-access-token');
      expect(mockDecryptCalendarToken).toHaveBeenCalledWith('encrypted-access');
    });

    it('triggers refresh when token expires within 1 hour', async () => {
      const connection = makeConnection({
        tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const mockRefresh = vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      });
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      const result = await getValidAccessToken(EXPERT_ID);

      expect(result).toBe('new-access-token');
      // A2 (security review CRITICAL) — `provider` MUST be threaded through so the
      // repository write is scoped to this connection's own provider, not merely this
      // expert (an expert-scoped-only write can land on a DIFFERENT provider's row once
      // an expert holds two live connections).
      expect(mockUpdateConnectionTokens).toHaveBeenCalledWith(EXPERT_ID, 'google', {
        accessToken: 'encrypted_new-access-token',
        refreshToken: 'encrypted_new-refresh-token',
        tokenExpiresAt: expect.any(Date),
      });
      expect(mockTrackServer).toHaveBeenCalled();
    });

    it("scopes the token write to the connection's OWN provider, not merely the expert (A2 regression pin)", async () => {
      const connection = makeConnection({
        provider: 'microsoft',
        tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const mockRefresh = vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      });
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      await getValidAccessToken(EXPERT_ID);

      expect(mockUpdateConnectionTokens).toHaveBeenCalledWith(
        EXPERT_ID,
        'microsoft',
        expect.anything()
      );
    });

    it('handles refresh without new refresh token', async () => {
      const connection = makeConnection({
        tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const mockRefresh = vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: null,
        expires_in: 3600,
      });
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      await getValidAccessToken(EXPERT_ID);

      expect(mockUpdateConnectionTokens).toHaveBeenCalledWith(EXPERT_ID, 'google', {
        accessToken: 'encrypted_new-access-token',
        refreshToken: undefined,
        tokenExpiresAt: expect.any(Date),
      });
    });

    it('marks auth_error on invalid_grant and throws CalendarAuthError', async () => {
      const connection = makeConnection({
        tokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // needs refresh
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const mockRefresh = vi.fn().mockRejectedValue({ error: 'invalid_grant' });
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(CalendarAuthError);
      expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(EXPERT_ID, 'auth_error');
      expect(mockClearAvailabilityCache).toHaveBeenCalledWith(EXPERT_ID);
    });

    it('re-throws non-invalid_grant errors during refresh', async () => {
      const connection = makeConnection({
        tokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const err = new Error('Network timeout');
      const mockRefresh = vi.fn().mockRejectedValue(err);
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toBe(err);
      expect(mockUpdateConnectionStatus).not.toHaveBeenCalled();
    });

    it('throws CalendarNotConnectedError for an Apiroc-shaped row (null tokenExpiresAt)', async () => {
      // BAL-467: an Apiroc-shaped row stores only end_user_account_id — no Cronofy
      // token fields — so the oldest-live-first lookup must not NPE on `.getTime()`.
      const connection = makeConnection({
        tokenExpiresAt: null as unknown as Date,
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('throws CalendarNotConnectedError for an Apiroc-shaped row (null accessToken)', async () => {
      const connection = makeConnection({
        accessToken: null as unknown as string,
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('throws CalendarNotConnectedError for an Apiroc-shaped row (null refreshToken)', async () => {
      const connection = makeConnection({
        refreshToken: null as unknown as string,
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('throws when CRONOFY_CLIENT_ID is missing during refresh', async () => {
      delete process.env.CRONOFY_CLIENT_ID;
      const connection = makeConnection({
        tokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      await expect(getValidAccessToken(EXPERT_ID)).rejects.toThrow(
        'CRONOFY_CLIENT_ID and CRONOFY_CLIENT_SECRET must be set'
      );
    });
  });

  describe('forceRefreshToken', () => {
    it('throws CalendarNotConnectedError when no connection found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      await expect(forceRefreshToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('throws CalendarNotConnectedError for an Apiroc-shaped row (null token fields)', async () => {
      const connection = makeConnection({
        accessToken: null as unknown as string,
        refreshToken: null as unknown as string,
        tokenExpiresAt: null as unknown as Date,
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      await expect(forceRefreshToken(EXPERT_ID)).rejects.toThrow(CalendarNotConnectedError);
    });

    it('force-refreshes and returns new access token', async () => {
      const connection = makeConnection();
      mockFindConnectionByExpertProfileId.mockResolvedValue(connection);

      const mockRefresh = vi.fn().mockResolvedValue({
        access_token: 'forced-new-token',
        refresh_token: 'forced-new-refresh',
        expires_in: 7200,
      });
      mockGetCronofyAppClient.mockReturnValue({ refreshAccessToken: mockRefresh });

      const result = await forceRefreshToken(EXPERT_ID);

      expect(result).toBe('forced-new-token');
      expect(mockUpdateConnectionTokens).toHaveBeenCalled();
    });
  });
});
