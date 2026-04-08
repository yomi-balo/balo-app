import Cronofy from 'cronofy';

function getCronofyConfig(): {
  client_id: string;
  client_secret: string;
  data_center: string;
} {
  const client_id = process.env.CRONOFY_CLIENT_ID;
  const client_secret = process.env.CRONOFY_CLIENT_SECRET;
  const data_center = process.env.CRONOFY_DATA_CENTER;

  if (!client_id || !client_secret || !data_center) {
    throw new Error(
      'Missing Cronofy configuration — CRONOFY_CLIENT_ID, CRONOFY_CLIENT_SECRET, and CRONOFY_DATA_CENTER must all be set'
    );
  }

  return { client_id, client_secret, data_center };
}

/**
 * App-level Cronofy client (no access token).
 * Used for token exchange, refresh, revoke, and auth URL generation.
 */
export function getCronofyAppClient(): InstanceType<typeof Cronofy> {
  return new Cronofy(getCronofyConfig());
}

/**
 * Per-user Cronofy client with access token.
 * Used for list calendars, push channels, free/busy, etc.
 */
export function getCronofyUserClient(accessToken: string): InstanceType<typeof Cronofy> {
  return new Cronofy({
    ...getCronofyConfig(),
    access_token: accessToken,
  });
}
