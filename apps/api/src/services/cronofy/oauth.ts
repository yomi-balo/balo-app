import crypto from 'crypto';
import { calendarRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { getCronofyAppClient, getCronofyUserClient } from '../../lib/cronofy.js';
import { encryptCalendarToken, decryptCalendarToken } from '../../lib/calendar-encryption.js';

const log = createLogger('cronofy-oauth');

// ── State signing (HMAC-SHA256) ─────────────────────────────────

interface SignedStatePayload {
  expertProfileId: string;
  provider: string;
  ts: number;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Creates a signed state parameter for the OAuth redirect.
 * Format: base64(payload).base64(hmac)
 */
export function createSignedState(expertProfileId: string, provider: string): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('INTERNAL_API_SECRET is not configured');

  const payload: SignedStatePayload = {
    expertProfileId,
    provider,
    ts: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${hmac}`;
}

/**
 * Verifies the signed state and returns the payload.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifySignedState(state: string): SignedStatePayload {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('INTERNAL_API_SECRET is not configured');

  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid state format');
  }

  const [payloadB64, providedHmac] = parts as [string, string];

  // Timing-safe comparison
  const expectedHmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const a = Buffer.from(providedHmac);
  const b = Buffer.from(expectedHmac);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid state signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as SignedStatePayload;

  // Check expiry
  if (Date.now() - payload.ts > STATE_TTL_MS) {
    throw new Error('State has expired');
  }

  return payload;
}

// ── Auth URL generation ─────────────────────────────────────────

/**
 * Maps Balo provider names to Cronofy provider_name values.
 * Cronofy uses 'office365' not 'microsoft'.
 */
function mapProviderName(provider: string): string {
  if (provider === 'microsoft') return 'office365';
  return provider;
}

/**
 * Generates the Cronofy authorization URL for the Individual Connect flow.
 */
export function generateCronofyAuthUrl(expertProfileId: string, provider: string): string {
  const clientId = process.env.CRONOFY_CLIENT_ID;
  const redirectUri = process.env.CRONOFY_REDIRECT_URI;
  const dataCenter = process.env.CRONOFY_DATA_CENTER || '';

  if (!clientId || !redirectUri) {
    throw new Error('CRONOFY_CLIENT_ID and CRONOFY_REDIRECT_URI must be configured');
  }

  const state = createSignedState(expertProfileId, provider);

  // Build the data center URL prefix for the OAuth authorize URL.
  // CRONOFY_DATA_CENTER values are "api-au", "api-us", etc.
  // The OAuth URL uses "app-au", "app-de", etc. — strip the "api-" prefix.
  let dcPrefix = '';
  if (dataCenter) {
    const region = dataCenter.toLowerCase().replace(/^api-/, '');
    if (region && region !== 'us') {
      dcPrefix = `-${region}`;
    }
  }

  const scope = 'read_write create_event delete_event list_calendars read_account read_events';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    avoid_linking: 'true', // MANDATORY — G3
    provider_name: mapProviderName(provider),
  });

  return `https://app${dcPrefix}.cronofy.com/oauth/authorize?${params.toString()}`;
}

// ── OAuth callback handler ──────────────────────────────────────

interface OAuthCallbackResult {
  expertProfileId: string;
  provider: string;
  status: 'connected' | 'sync_pending';
}

/**
 * Handles the Cronofy OAuth callback.
 * Exchanges code for tokens, checks userinfo, stores encrypted tokens,
 * lists calendars, sets default target calendar, and registers push channel.
 */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<OAuthCallbackResult> {
  // 1. Verify state
  const { expertProfileId, provider } = verifySignedState(state);

  // 2. Exchange code for tokens
  const clientId = process.env.CRONOFY_CLIENT_ID;
  const clientSecret = process.env.CRONOFY_CLIENT_SECRET;
  const redirectUri = process.env.CRONOFY_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'CRONOFY_CLIENT_ID, CRONOFY_CLIENT_SECRET, and CRONOFY_REDIRECT_URI must be set'
    );
  }

  const cronofyApp = getCronofyAppClient();
  const tokenResponse = await cronofyApp.requestAccessToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

  // 3. Store encrypted tokens
  const connection = await calendarRepository.upsertConnection({
    expertProfileId,
    cronofySub: tokenResponse.sub,
    provider,
    providerEmail: tokenResponse.linking_profile?.profile_name ?? null,
    accessToken: encryptCalendarToken(tokenResponse.access_token),
    refreshToken: encryptCalendarToken(tokenResponse.refresh_token),
    tokenExpiresAt: expiresAt,
    status: 'connected',
  });

  // 4. Check userinfo for initial sync pending (G1)
  const userClient = getCronofyUserClient(tokenResponse.access_token);
  const userInfo = await userClient.userInfo();
  const profile = userInfo.profiles?.[0];

  if (profile?.profile_initial_sync_required) {
    await calendarRepository.updateConnectionStatus(expertProfileId, 'sync_pending');
    log.warn(
      { expertProfileId, provider },
      'Calendar connection in sync_pending — user may not have granted all scopes'
    );
    return { expertProfileId, provider, status: 'sync_pending' };
  }

  // 5. List and store calendars
  await listAndStoreCalendars(expertProfileId, tokenResponse.access_token, connection.id);

  // 6. Set default target calendar (primary)
  const subCalendars = await calendarRepository.findSubCalendarsByConnectionId(connection.id);
  const primary = subCalendars.find((cal) => cal.isPrimary);
  if (primary) {
    await calendarRepository.updateTargetCalendarId(expertProfileId, primary.calendarId);
  }

  // 7. Register push notification channel
  await registerPushChannel(expertProfileId, tokenResponse.access_token);

  return { expertProfileId, provider, status: 'connected' };
}

// ── Calendar listing ────────────────────────────────────────────

/**
 * Lists calendars from Cronofy and stores writable ones as sub-calendars.
 * Filters out deleted and read-only calendars.
 */
export async function listAndStoreCalendars(
  expertProfileId: string,
  accessToken: string,
  connectionId?: string
): Promise<void> {
  const userClient = getCronofyUserClient(accessToken);
  const { calendars } = await userClient.listCalendars();

  // Get connection ID if not provided
  let connId = connectionId;
  if (!connId) {
    const connection = await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
    if (!connection) {
      throw new Error(`No calendar connection found for expert ${expertProfileId}`);
    }
    connId = connection.id;
  }

  // Filter out deleted and read-only calendars
  const writableCalendars = calendars.filter(
    (cal) => !cal.calendar_deleted && !cal.calendar_readonly
  );

  await calendarRepository.replaceSubCalendars(
    connId,
    writableCalendars.map((cal) => ({
      calendarId: cal.calendar_id,
      name: cal.calendar_name,
      provider: cal.provider_name,
      profileName: cal.profile_name,
      isPrimary: cal.calendar_primary,
      conflictCheck: cal.calendar_primary, // Primary defaults to true, others to false
      color: cal.calendar_color ?? null,
    }))
  );
}

// ── Push notification channel ───────────────────────────────────

/**
 * Registers a push notification channel for an expert.
 * Closes any existing channel first (idempotent reconnect).
 */
export async function registerPushChannel(
  expertProfileId: string,
  accessToken: string
): Promise<void> {
  const userClient = getCronofyUserClient(accessToken);

  // Close existing channel (best effort)
  const existingConnection =
    await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
  if (existingConnection?.channelId) {
    try {
      await userClient.deleteNotificationChannel({ channel_id: existingConnection.channelId });
    } catch {
      // Best effort — channel may already be closed
    }
  }

  const callbackUrl = `${process.env.API_BASE_URL}/webhooks/cronofy`;
  const { channel } = await userClient.createNotificationChannel({
    callback_url: callbackUrl,
    filters: { only_managed: false },
  });

  await calendarRepository.updateConnectionChannelId(expertProfileId, channel.channel_id);
}

// ── Disconnect ──────────────────────────────────────────────────

/**
 * Disconnects a calendar connection.
 * Closes push channel (best effort), revokes authorization (best effort),
 * deletes sub-calendars, soft-deletes connection, and clears availability cache.
 */
export async function disconnectCalendar(expertProfileId: string): Promise<void> {
  const connection = await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
  if (!connection) return;

  // 1. Close push channel (best effort)
  if (connection.channelId) {
    try {
      const accessToken = decryptCalendarToken(connection.accessToken);
      const userClient = getCronofyUserClient(accessToken);
      await userClient.deleteNotificationChannel({ channel_id: connection.channelId });
    } catch (err: unknown) {
      log.warn(
        { expertProfileId, error: err instanceof Error ? err.message : String(err) },
        'Failed to close push channel during disconnect (best effort)'
      );
    }
  }

  // 2. Revoke Cronofy authorization (best effort)
  try {
    const refreshToken = decryptCalendarToken(connection.refreshToken);
    const revokeClientId = process.env.CRONOFY_CLIENT_ID;
    const revokeClientSecret = process.env.CRONOFY_CLIENT_SECRET;
    if (!revokeClientId || !revokeClientSecret) {
      throw new Error('CRONOFY_CLIENT_ID and CRONOFY_CLIENT_SECRET must be set');
    }
    const cronofyApp = getCronofyAppClient();
    await cronofyApp.revokeAuthorization({
      client_id: revokeClientId,
      client_secret: revokeClientSecret,
      token: refreshToken,
    });
  } catch (err: unknown) {
    log.warn(
      { expertProfileId, error: err instanceof Error ? err.message : String(err) },
      'Failed to revoke Cronofy authorization during disconnect (best effort)'
    );
  }

  // 3. Delete sub-calendars
  await calendarRepository.deleteSubCalendarsByConnectionId(connection.id);

  // 4. Soft-delete the connection
  await calendarRepository.softDeleteConnection(expertProfileId);

  // 5. Clear availability cache
  await calendarRepository.clearAvailabilityCache(expertProfileId);
}
