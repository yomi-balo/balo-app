import { calendarRepository } from '@balo/db';
import { getCronofyAppClient } from '../../lib/cronofy.js';
import { encryptCalendarToken, decryptCalendarToken } from '../../lib/calendar-encryption.js';
import { CalendarNotConnectedError, CalendarAuthError } from './errors.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Returns a valid (decrypted) access token for the expert.
 * Proactively refreshes if the token expires within 1 hour.
 */
export async function getValidAccessToken(expertProfileId: string): Promise<string> {
  const connection = await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
  if (!connection) {
    throw new CalendarNotConnectedError(expertProfileId);
  }

  const expiresIn = connection.tokenExpiresAt.getTime() - Date.now();

  if (expiresIn < ONE_HOUR_MS) {
    return refreshAccessToken(expertProfileId, connection.refreshToken);
  }

  return decryptCalendarToken(connection.accessToken);
}

/**
 * Force-refresh the access token (used on 401 retry).
 */
export async function forceRefreshToken(expertProfileId: string): Promise<string> {
  const connection = await calendarRepository.findConnectionByExpertProfileId(expertProfileId);
  if (!connection) {
    throw new CalendarNotConnectedError(expertProfileId);
  }

  return refreshAccessToken(expertProfileId, connection.refreshToken);
}

/**
 * Refreshes the access token using the encrypted refresh token.
 * On `invalid_grant`, marks the connection as `auth_error`.
 */
async function refreshAccessToken(
  expertProfileId: string,
  encryptedRefreshToken: string
): Promise<string> {
  const cronofyApp = getCronofyAppClient();
  const decryptedRefreshToken = decryptCalendarToken(encryptedRefreshToken);

  const clientId = process.env.CRONOFY_CLIENT_ID;
  const clientSecret = process.env.CRONOFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('CRONOFY_CLIENT_ID and CRONOFY_CLIENT_SECRET must be set');
  }

  try {
    const tokenResponse = await cronofyApp.refreshAccessToken({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: decryptedRefreshToken,
    });

    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

    await calendarRepository.updateConnectionTokens(expertProfileId, {
      accessToken: encryptCalendarToken(tokenResponse.access_token),
      refreshToken: tokenResponse.refresh_token
        ? encryptCalendarToken(tokenResponse.refresh_token)
        : undefined,
      tokenExpiresAt: expiresAt,
    });

    trackServer(CALENDAR_SERVER_EVENTS.TOKEN_REFRESHED, {
      distinct_id: expertProfileId,
    });

    return tokenResponse.access_token;
  } catch (err: unknown) {
    const errorCode = (err as { error?: string }).error;

    if (errorCode === 'invalid_grant') {
      // Refresh token revoked — mark auth_error, clear cache
      await calendarRepository.updateConnectionStatus(expertProfileId, 'auth_error');
      await calendarRepository.clearAvailabilityCache(expertProfileId);
      // TODO: Publish domain event for reconnect email via notification engine.
      // Requires notification rule + Brevo template setup (separate task).
      throw new CalendarAuthError(`Calendar authorization revoked for expert ${expertProfileId}`);
    }

    throw err;
  }
}
