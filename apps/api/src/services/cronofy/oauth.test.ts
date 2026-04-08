import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockUpsertConnection,
  mockUpdateConnectionStatus,
  mockFindSubCalendarsByConnectionId,
  mockUpdateTargetCalendarId,
  mockFindConnectionByExpertProfileId,
  mockUpdateConnectionChannelId,
  mockReplaceSubCalendars,
  mockDeleteSubCalendarsByConnectionId,
  mockSoftDeleteConnection,
  mockClearAvailabilityCache,
  mockGetCronofyAppClient,
  mockGetCronofyUserClient,
  mockEncryptCalendarToken,
  mockDecryptCalendarToken,
} = vi.hoisted(() => ({
  mockUpsertConnection: vi.fn(),
  mockUpdateConnectionStatus: vi.fn(),
  mockFindSubCalendarsByConnectionId: vi.fn(),
  mockUpdateTargetCalendarId: vi.fn(),
  mockFindConnectionByExpertProfileId: vi.fn(),
  mockUpdateConnectionChannelId: vi.fn(),
  mockReplaceSubCalendars: vi.fn(),
  mockDeleteSubCalendarsByConnectionId: vi.fn(),
  mockSoftDeleteConnection: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
  mockGetCronofyAppClient: vi.fn(),
  mockGetCronofyUserClient: vi.fn(),
  mockEncryptCalendarToken: vi.fn(),
  mockDecryptCalendarToken: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    upsertConnection: mockUpsertConnection,
    updateConnectionStatus: mockUpdateConnectionStatus,
    findSubCalendarsByConnectionId: mockFindSubCalendarsByConnectionId,
    updateTargetCalendarId: mockUpdateTargetCalendarId,
    findConnectionByExpertProfileId: mockFindConnectionByExpertProfileId,
    updateConnectionChannelId: mockUpdateConnectionChannelId,
    replaceSubCalendars: mockReplaceSubCalendars,
    deleteSubCalendarsByConnectionId: mockDeleteSubCalendarsByConnectionId,
    softDeleteConnection: mockSoftDeleteConnection,
    clearAvailabilityCache: mockClearAvailabilityCache,
  },
}));

vi.mock('../../lib/cronofy.js', () => ({
  getCronofyAppClient: mockGetCronofyAppClient,
  getCronofyUserClient: mockGetCronofyUserClient,
}));

vi.mock('../../lib/calendar-encryption.js', () => ({
  encryptCalendarToken: mockEncryptCalendarToken,
  decryptCalendarToken: mockDecryptCalendarToken,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createSignedState,
  verifySignedState,
  generateCronofyAuthUrl,
  handleOAuthCallback,
  listAndStoreCalendars,
  registerPushChannel,
  disconnectCalendar,
} from './oauth';

// ── Test setup ─────────────────────────────────────────────────

const EXPERT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_SECRET = 'test-internal-api-secret';

describe('oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    process.env.CRONOFY_CLIENT_ID = 'test-client-id';
    process.env.CRONOFY_CLIENT_SECRET = 'test-client-secret';
    process.env.CRONOFY_REDIRECT_URI = 'https://api.balo.test/auth/cronofy/callback';
    process.env.CRONOFY_DATA_CENTER = '';
    process.env.API_BASE_URL = 'https://api.balo.test';
    mockEncryptCalendarToken.mockImplementation((v: string) => `enc_${v}`);
    mockDecryptCalendarToken.mockImplementation((v: string) => v.replace('enc_', ''));
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_SECRET;
    delete process.env.CRONOFY_CLIENT_ID;
    delete process.env.CRONOFY_CLIENT_SECRET;
    delete process.env.CRONOFY_REDIRECT_URI;
    delete process.env.CRONOFY_DATA_CENTER;
    delete process.env.API_BASE_URL;
  });

  // ── createSignedState / verifySignedState ─────────────────────

  describe('createSignedState / verifySignedState', () => {
    it('round-trips state creation and verification', () => {
      const state = createSignedState(EXPERT_ID, 'google');
      const payload = verifySignedState(state);

      expect(payload.expertProfileId).toBe(EXPERT_ID);
      expect(payload.provider).toBe('google');
      expect(payload.ts).toBeGreaterThan(0);
    });

    it('throws when INTERNAL_API_SECRET is missing on create', () => {
      delete process.env.INTERNAL_API_SECRET;
      expect(() => createSignedState(EXPERT_ID, 'google')).toThrow(
        'INTERNAL_API_SECRET is not configured'
      );
    });

    it('throws when INTERNAL_API_SECRET is missing on verify', () => {
      const state = createSignedState(EXPERT_ID, 'google');
      delete process.env.INTERNAL_API_SECRET;
      expect(() => verifySignedState(state)).toThrow('INTERNAL_API_SECRET is not configured');
    });

    it('throws on invalid state format (no dot)', () => {
      expect(() => verifySignedState('nodothere')).toThrow('Invalid state format');
    });

    it('throws on tampered signature', () => {
      const state = createSignedState(EXPERT_ID, 'google');
      const [payload] = state.split('.');
      const tampered = `${payload}.badsignature`;
      expect(() => verifySignedState(tampered)).toThrow('Invalid state signature');
    });

    it('throws on expired state', () => {
      // Create a state with old timestamp by mocking Date.now
      const originalNow = Date.now;
      Date.now = () => originalNow() - 11 * 60 * 1000; // 11 minutes ago
      const state = createSignedState(EXPERT_ID, 'google');
      Date.now = originalNow;

      expect(() => verifySignedState(state)).toThrow('State has expired');
    });
  });

  // ── generateCronofyAuthUrl ────────────────────────────────────

  describe('generateCronofyAuthUrl', () => {
    it('generates a valid URL with required params', () => {
      const url = generateCronofyAuthUrl(EXPERT_ID, 'google');

      expect(url).toContain('https://app.cronofy.com/oauth/authorize');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('avoid_linking=true');
      expect(url).toContain('provider_name=google');
      expect(url).toContain('state=');
    });

    it('maps microsoft to office365', () => {
      const url = generateCronofyAuthUrl(EXPERT_ID, 'microsoft');
      expect(url).toContain('provider_name=office365');
    });

    it('uses data center prefix for non-US regions', () => {
      process.env.CRONOFY_DATA_CENTER = 'api-au';
      const url = generateCronofyAuthUrl(EXPERT_ID, 'google');
      expect(url).toContain('https://app-au.cronofy.com/oauth/authorize');
    });

    it('uses no prefix for US data center', () => {
      process.env.CRONOFY_DATA_CENTER = 'api-us';
      const url = generateCronofyAuthUrl(EXPERT_ID, 'google');
      expect(url).toContain('https://app.cronofy.com/oauth/authorize');
    });

    it('uses no prefix for empty data center', () => {
      process.env.CRONOFY_DATA_CENTER = '';
      const url = generateCronofyAuthUrl(EXPERT_ID, 'google');
      expect(url).toContain('https://app.cronofy.com/oauth/authorize');
    });

    it('throws when CRONOFY_CLIENT_ID is missing', () => {
      delete process.env.CRONOFY_CLIENT_ID;
      expect(() => generateCronofyAuthUrl(EXPERT_ID, 'google')).toThrow(
        'CRONOFY_CLIENT_ID and CRONOFY_REDIRECT_URI must be configured'
      );
    });

    it('throws when CRONOFY_REDIRECT_URI is missing', () => {
      delete process.env.CRONOFY_REDIRECT_URI;
      expect(() => generateCronofyAuthUrl(EXPERT_ID, 'google')).toThrow(
        'CRONOFY_CLIENT_ID and CRONOFY_REDIRECT_URI must be configured'
      );
    });
  });

  // ── handleOAuthCallback ───────────────────────────────────────

  describe('handleOAuthCallback', () => {
    const mockTokenResponse = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      sub: 'cronofy-sub-1',
      linking_profile: { profile_name: 'user@gmail.com' },
    };

    const mockUserClient = {
      userInfo: vi.fn(),
      listCalendars: vi.fn(),
      createNotificationChannel: vi.fn(),
      deleteNotificationChannel: vi.fn(),
    };

    beforeEach(() => {
      mockGetCronofyAppClient.mockReturnValue({
        requestAccessToken: vi.fn().mockResolvedValue(mockTokenResponse),
      });
      mockGetCronofyUserClient.mockReturnValue(mockUserClient);
      mockUpsertConnection.mockResolvedValue({ id: 'conn-1', expertProfileId: EXPERT_ID });
      mockUserClient.userInfo.mockResolvedValue({
        profiles: [{ profile_initial_sync_required: false }],
      });
      mockUserClient.listCalendars.mockResolvedValue({
        calendars: [
          {
            calendar_id: 'cal-1',
            calendar_name: 'Primary',
            provider_name: 'google',
            profile_name: 'user@gmail.com',
            calendar_primary: true,
            calendar_deleted: false,
            calendar_readonly: false,
            calendar_color: '#4285F4',
          },
        ],
      });
      mockFindSubCalendarsByConnectionId.mockResolvedValue([
        { calendarId: 'cal-1', isPrimary: true },
      ]);
      mockUserClient.createNotificationChannel.mockResolvedValue({
        channel: { channel_id: 'ch-1' },
      });
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1', channelId: null });
    });

    it('exchanges code, stores tokens, lists calendars, returns connected', async () => {
      const state = createSignedState(EXPERT_ID, 'google');
      const result = await handleOAuthCallback('auth-code-123', state);

      expect(result).toEqual({
        expertProfileId: EXPERT_ID,
        provider: 'google',
        status: 'connected',
      });
      expect(mockUpsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          expertProfileId: EXPERT_ID,
          cronofySub: 'cronofy-sub-1',
          provider: 'google',
          providerEmail: 'user@gmail.com',
          accessToken: 'enc_new-access',
          refreshToken: 'enc_new-refresh',
          status: 'connected',
        })
      );
      expect(mockUpdateTargetCalendarId).toHaveBeenCalledWith(EXPERT_ID, 'cal-1');
      expect(mockUpdateConnectionChannelId).toHaveBeenCalled();
    });

    it('returns sync_pending when profile_initial_sync_required is true', async () => {
      mockUserClient.userInfo.mockResolvedValue({
        profiles: [{ profile_initial_sync_required: true }],
      });

      const state = createSignedState(EXPERT_ID, 'google');
      const result = await handleOAuthCallback('auth-code-123', state);

      expect(result.status).toBe('sync_pending');
      expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(EXPERT_ID, 'sync_pending');
      // Should not list calendars or register push channel
      expect(mockUserClient.listCalendars).not.toHaveBeenCalled();
    });

    it('does not set target calendar when no primary found', async () => {
      mockFindSubCalendarsByConnectionId.mockResolvedValue([
        { calendarId: 'cal-2', isPrimary: false },
      ]);

      const state = createSignedState(EXPERT_ID, 'google');
      await handleOAuthCallback('auth-code-123', state);

      expect(mockUpdateTargetCalendarId).not.toHaveBeenCalled();
    });

    it('handles missing linking_profile gracefully', async () => {
      mockGetCronofyAppClient.mockReturnValue({
        requestAccessToken: vi.fn().mockResolvedValue({
          ...mockTokenResponse,
          linking_profile: undefined,
        }),
      });

      const state = createSignedState(EXPERT_ID, 'google');
      await handleOAuthCallback('auth-code-123', state);

      expect(mockUpsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({ providerEmail: null })
      );
    });

    it('throws when env vars are missing', async () => {
      delete process.env.CRONOFY_CLIENT_ID;
      const state = createSignedState(EXPERT_ID, 'google');
      // Need to re-set INTERNAL_API_SECRET since createSignedState consumed it
      process.env.INTERNAL_API_SECRET = TEST_SECRET;

      await expect(handleOAuthCallback('code', state)).rejects.toThrow(
        'CRONOFY_CLIENT_ID, CRONOFY_CLIENT_SECRET, and CRONOFY_REDIRECT_URI must be set'
      );
    });
  });

  // ── listAndStoreCalendars ─────────────────────────────────────

  describe('listAndStoreCalendars', () => {
    const mockUserClient = {
      listCalendars: vi.fn(),
    };

    beforeEach(() => {
      mockGetCronofyUserClient.mockReturnValue(mockUserClient);
    });

    it('filters out deleted and readonly calendars', async () => {
      mockUserClient.listCalendars.mockResolvedValue({
        calendars: [
          {
            calendar_id: 'cal-1',
            calendar_name: 'Primary',
            provider_name: 'google',
            profile_name: 'user@gmail.com',
            calendar_primary: true,
            calendar_deleted: false,
            calendar_readonly: false,
            calendar_color: '#4285F4',
          },
          {
            calendar_id: 'cal-deleted',
            calendar_name: 'Deleted',
            provider_name: 'google',
            profile_name: 'user@gmail.com',
            calendar_primary: false,
            calendar_deleted: true,
            calendar_readonly: false,
          },
          {
            calendar_id: 'cal-readonly',
            calendar_name: 'ReadOnly',
            provider_name: 'google',
            profile_name: 'user@gmail.com',
            calendar_primary: false,
            calendar_deleted: false,
            calendar_readonly: true,
          },
        ],
      });

      await listAndStoreCalendars(EXPERT_ID, 'access-token', 'conn-1');

      expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
        expect.objectContaining({
          calendarId: 'cal-1',
          name: 'Primary',
          isPrimary: true,
          conflictCheck: true,
        }),
      ]);
    });

    it('looks up connection when connectionId not provided', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-2' });
      mockUserClient.listCalendars.mockResolvedValue({ calendars: [] });

      await listAndStoreCalendars(EXPERT_ID, 'access-token');

      expect(mockFindConnectionByExpertProfileId).toHaveBeenCalledWith(EXPERT_ID);
      expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-2', []);
    });

    it('throws when no connection found and connectionId not provided', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      await expect(listAndStoreCalendars(EXPERT_ID, 'access-token')).rejects.toThrow(
        `No calendar connection found for expert ${EXPERT_ID}`
      );
    });

    it('sets conflictCheck to false for non-primary calendars', async () => {
      mockUserClient.listCalendars.mockResolvedValue({
        calendars: [
          {
            calendar_id: 'cal-2',
            calendar_name: 'Secondary',
            provider_name: 'google',
            profile_name: 'user@gmail.com',
            calendar_primary: false,
            calendar_deleted: false,
            calendar_readonly: false,
            calendar_color: null,
          },
        ],
      });

      await listAndStoreCalendars(EXPERT_ID, 'access-token', 'conn-1');

      expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
        expect.objectContaining({
          calendarId: 'cal-2',
          isPrimary: false,
          conflictCheck: false,
          color: null,
        }),
      ]);
    });
  });

  // ── registerPushChannel ───────────────────────────────────────

  describe('registerPushChannel', () => {
    const mockUserClient = {
      createNotificationChannel: vi.fn(),
      deleteNotificationChannel: vi.fn(),
    };

    beforeEach(() => {
      mockGetCronofyUserClient.mockReturnValue(mockUserClient);
      mockUserClient.createNotificationChannel.mockResolvedValue({
        channel: { channel_id: 'ch-new' },
      });
    });

    it('closes existing channel before creating new one', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        channelId: 'ch-old',
      });

      await registerPushChannel(EXPERT_ID, 'access-token');

      expect(mockUserClient.deleteNotificationChannel).toHaveBeenCalledWith({
        channel_id: 'ch-old',
      });
      expect(mockUserClient.createNotificationChannel).toHaveBeenCalled();
      expect(mockUpdateConnectionChannelId).toHaveBeenCalledWith(EXPERT_ID, 'ch-new');
    });

    it('skips delete when no existing channel', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        channelId: null,
      });

      await registerPushChannel(EXPERT_ID, 'access-token');

      expect(mockUserClient.deleteNotificationChannel).not.toHaveBeenCalled();
      expect(mockUserClient.createNotificationChannel).toHaveBeenCalled();
    });

    it('ignores errors when closing existing channel (best effort)', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        channelId: 'ch-old',
      });
      mockUserClient.deleteNotificationChannel.mockRejectedValue(new Error('Already closed'));

      await registerPushChannel(EXPERT_ID, 'access-token');

      // Should still create new channel despite delete failure
      expect(mockUserClient.createNotificationChannel).toHaveBeenCalled();
      expect(mockUpdateConnectionChannelId).toHaveBeenCalledWith(EXPERT_ID, 'ch-new');
    });

    it('uses correct callback URL from env', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1', channelId: null });

      await registerPushChannel(EXPERT_ID, 'access-token');

      expect(mockUserClient.createNotificationChannel).toHaveBeenCalledWith({
        callback_url: 'https://api.balo.test/webhooks/cronofy',
        filters: { only_managed: false },
      });
    });
  });

  // ── disconnectCalendar ────────────────────────────────────────

  describe('disconnectCalendar', () => {
    const mockUserClient = {
      deleteNotificationChannel: vi.fn(),
    };

    beforeEach(() => {
      mockGetCronofyUserClient.mockReturnValue(mockUserClient);
    });

    it('does nothing when no connection found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      await disconnectCalendar(EXPERT_ID);

      expect(mockDeleteSubCalendarsByConnectionId).not.toHaveBeenCalled();
      expect(mockSoftDeleteConnection).not.toHaveBeenCalled();
    });

    it('closes channel, revokes auth, deletes sub-calendars, soft-deletes, clears cache', async () => {
      const mockApp = { revokeAuthorization: vi.fn().mockResolvedValue(undefined) };
      mockGetCronofyAppClient.mockReturnValue(mockApp);
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        expertProfileId: EXPERT_ID,
        channelId: 'ch-1',
        accessToken: 'enc_access',
        refreshToken: 'enc_refresh',
      });

      await disconnectCalendar(EXPERT_ID);

      expect(mockUserClient.deleteNotificationChannel).toHaveBeenCalledWith({
        channel_id: 'ch-1',
      });
      expect(mockApp.revokeAuthorization).toHaveBeenCalled();
      expect(mockDeleteSubCalendarsByConnectionId).toHaveBeenCalledWith('conn-1');
      expect(mockSoftDeleteConnection).toHaveBeenCalledWith(EXPERT_ID);
      expect(mockClearAvailabilityCache).toHaveBeenCalledWith(EXPERT_ID);
    });

    it('continues disconnect even when channel close fails', async () => {
      const mockApp = { revokeAuthorization: vi.fn().mockResolvedValue(undefined) };
      mockGetCronofyAppClient.mockReturnValue(mockApp);
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        expertProfileId: EXPERT_ID,
        channelId: 'ch-1',
        accessToken: 'enc_access',
        refreshToken: 'enc_refresh',
      });
      mockUserClient.deleteNotificationChannel.mockRejectedValue(new Error('Channel gone'));

      await disconnectCalendar(EXPERT_ID);

      // Should still soft-delete and clear cache
      expect(mockSoftDeleteConnection).toHaveBeenCalledWith(EXPERT_ID);
      expect(mockClearAvailabilityCache).toHaveBeenCalledWith(EXPERT_ID);
    });

    it('continues disconnect even when revoke auth fails', async () => {
      const mockApp = {
        revokeAuthorization: vi.fn().mockRejectedValue(new Error('Revoke failed')),
      };
      mockGetCronofyAppClient.mockReturnValue(mockApp);
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        expertProfileId: EXPERT_ID,
        channelId: null,
        accessToken: 'enc_access',
        refreshToken: 'enc_refresh',
      });

      await disconnectCalendar(EXPERT_ID);

      expect(mockSoftDeleteConnection).toHaveBeenCalledWith(EXPERT_ID);
      expect(mockClearAvailabilityCache).toHaveBeenCalledWith(EXPERT_ID);
    });

    it('skips channel close when no channelId', async () => {
      const mockApp = { revokeAuthorization: vi.fn().mockResolvedValue(undefined) };
      mockGetCronofyAppClient.mockReturnValue(mockApp);
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        expertProfileId: EXPERT_ID,
        channelId: null,
        accessToken: 'enc_access',
        refreshToken: 'enc_refresh',
      });

      await disconnectCalendar(EXPERT_ID);

      expect(mockUserClient.deleteNotificationChannel).not.toHaveBeenCalled();
    });
  });
});
