import { calendarRepository } from '@balo/db';
import { getValidAccessToken, forceRefreshToken } from './token-manager.js';
import { CalendarAuthError } from './errors.js';

/**
 * Wraps a Cronofy API call with automatic token refresh on 401.
 *
 * Flow:
 * 1. Get a valid access token (proactively refreshed if near expiry)
 * 2. Run the operation
 * 3. On 401 (not invalid_grant): force-refresh and retry once
 * 4. On 401 with invalid_grant: mark auth_error, throw CalendarAuthError
 */
export async function withCronofyRetry<T>(
  expertProfileId: string,
  operation: (accessToken: string) => Promise<T>
): Promise<T> {
  const accessToken = await getValidAccessToken(expertProfileId);

  try {
    return await operation(accessToken);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const errorCode = (err as { error?: string }).error;

    if (status === 401 && errorCode !== 'invalid_grant') {
      // Token may have just expired — try refreshing once
      const freshToken = await forceRefreshToken(expertProfileId);
      return await operation(freshToken);
    }

    if (status === 401 && errorCode === 'invalid_grant') {
      // Refresh token revoked — mark auth_error
      await calendarRepository.updateConnectionStatus(expertProfileId, 'auth_error');
      await calendarRepository.clearAvailabilityCache(expertProfileId);
      throw new CalendarAuthError(`Calendar authorization revoked for expert ${expertProfileId}`);
    }

    throw err;
  }
}
