# Cronofy OAuth — Individual Connect

## Flow Overview

```
1. Balo generates authorization URL with CRONOFY_CLIENT_ID + scopes
2. Expert redirected to Cronofy → provider (Google/Outlook) sign-in
3. Cronofy redirects back to CRONOFY_REDIRECT_URI with ?code=xxx
4. Balo exchanges code for access_token + refresh_token
5. Store sub, access_token, refresh_token, token_expires_at in DB
6. List calendars → store sub-calendar list
7. Register push notification channel
```

---

## Step 1: Generate Authorization URL

```typescript
// GET /auth/cronofy/connect
import { cronofyApp } from '@/lib/cronofy';

export async function getCronofyAuthUrl(expertId: string): Promise<string> {
  // Store expertId in state param so callback knows who connected
  const state = Buffer.from(JSON.stringify({ expertId })).toString('base64');

  return cronofyApp.generateAuthorizationUrl({
    redirect_uri: process.env.CRONOFY_REDIRECT_URI!,
    scope: 'read_write read_only create_event delete_event list_calendars read_account read_events',
    state,
    avoid_linking: true, // REQUIRED — prevents cookie-based merging of different experts' calendars
    // Optional: pre-fill with Google/Microsoft
    // provider_name: 'google',
  });
}
```

> **`avoid_linking: true` is mandatory.** Cronofy uses a browser cookie to decide if multiple
> calendar authorizations in the same session belong to the same user. Without this flag, two
> different experts authorizing from the same browser (common during dev/testing, or shared devices)
> will have their calendars silently merged under a single Cronofy `sub`. This is irreversible via
> the API — only Cronofy support can separate merged accounts.

> **Link tokens expire in 5 minutes.** If the OAuth flow uses the `link_token` parameter, generate
> it immediately before redirecting. Never pre-generate or cache link tokens.

**Scope explanation for Balo:**

- `read_write` — required for create/delete events
- `list_calendars` — enumerate sub-calendars
- `read_events` — for push notification delivery (Cronofy needs this internally)
- `read_account` — access sub and account info
- `create_event` / `delete_event` — explicit event permissions

---

## Step 2: Handle OAuth Callback

```typescript
// GET /auth/cronofy/callback?code=xxx&state=xxx
import { cronofyApp, cronofyUser } from '@/lib/cronofy';
import { db } from '@/db';
import { calendarConnections } from '@/db/schema';
import { encrypt } from '@/lib/encryption';

export async function handleCronofyCallback(code: string, state: string): Promise<void> {
  const { expertId } = JSON.parse(Buffer.from(state, 'base64').toString());

  // Exchange code for tokens
  const tokenResponse = await cronofyApp.requestAccessToken({
    client_id: process.env.CRONOFY_CLIENT_ID!,
    client_secret: process.env.CRONOFY_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.CRONOFY_REDIRECT_URI!,
  });

  // tokenResponse shape:
  // {
  //   access_token: string,
  //   refresh_token: string,
  //   expires_in: number,  // seconds (typically 1209600 = 14 days)
  //   token_type: 'bearer',
  //   scope: string,
  //   sub: string,         // Cronofy account identifier — store this
  //   account_id: string,
  //   linking_profile: { provider_name, profile_id, profile_name }
  // }

  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

  await db
    .insert(calendarConnections)
    .values({
      expertId,
      cronofySub: tokenResponse.sub,
      accessToken: encrypt(tokenResponse.access_token),
      refreshToken: encrypt(tokenResponse.refresh_token),
      tokenExpiresAt: expiresAt,
      status: 'connected',
    })
    .onConflictDoUpdate({
      target: calendarConnections.expertId,
      set: {
        cronofySub: tokenResponse.sub,
        accessToken: encrypt(tokenResponse.access_token),
        refreshToken: encrypt(tokenResponse.refresh_token),
        tokenExpiresAt: expiresAt,
        status: 'connected',
        updatedAt: new Date(),
      },
    });

  // Verify the connection completed successfully — check for initial sync pending.
  // In some Google environments, users must manually toggle permission checkboxes during OAuth.
  // Users who click through quickly miss these toggles, leaving the connection in a broken state
  // where Cronofy cannot pull down calendars (profile_initial_sync_required === true).
  const userInfo = await cronofyUser(tokenResponse.access_token).userInfo();
  const profile = userInfo.profiles?.[0];

  if (profile?.profile_initial_sync_required) {
    // Connection incomplete — mark as sync_pending, do NOT treat as fully connected.
    // Frontend should surface the profile relink URL to prompt the expert to re-authorize.
    await db
      .update(calendarConnections)
      .set({ status: 'sync_pending', updatedAt: new Date() })
      .where(eq(calendarConnections.expertId, expertId));
    return; // Do not proceed to listCalendars or registerPushChannel yet
  }

  // Trigger downstream jobs
  await listAndStoreCalendars(expertId, tokenResponse.access_token);
  await registerPushChannel(expertId, tokenResponse.access_token);
}
```

---

## Step 3: Token Refresh

Always refresh proactively before the token expires, not reactively on 401.

```typescript
import { cronofyApp } from '@/lib/cronofy';
import { encrypt, decrypt } from '@/lib/encryption';

export async function getValidAccessToken(expertId: string): Promise<string> {
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });

  if (!connection) throw new Error(`No calendar connection for expert ${expertId}`);

  // Refresh if token expires within 1 hour
  const expiresIn = connection.tokenExpiresAt.getTime() - Date.now();
  if (expiresIn < 60 * 60 * 1000) {
    return refreshAccessToken(connection);
  }

  return decrypt(connection.accessToken);
}

async function refreshAccessToken(connection: CalendarConnection): Promise<string> {
  const refreshed = await cronofyApp.refreshAccessToken({
    client_id: process.env.CRONOFY_CLIENT_ID!,
    client_secret: process.env.CRONOFY_CLIENT_SECRET!,
    grant_type: 'refresh_token',
    refresh_token: decrypt(connection.refreshToken),
  });

  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  await db
    .update(calendarConnections)
    .set({
      accessToken: encrypt(refreshed.access_token),
      tokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(calendarConnections.expertId, connection.expertId));

  return refreshed.access_token;
}
```

---

## Step 4: Disconnect

```typescript
export async function disconnectCalendar(expertId: string): Promise<void> {
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.expertId, expertId),
  });
  if (!connection) return;

  // Close push channel first
  if (connection.channelId) {
    const accessToken = decrypt(connection.accessToken);
    const client = cronofyUser(accessToken);
    await client.closeChannel({ channel_id: connection.channelId }).catch(() => {
      // Best effort — don't fail the disconnect if channel close fails
    });
  }

  // Revoke Cronofy authorization
  await cronofyApp.revokeAuthorization({
    client_id: process.env.CRONOFY_CLIENT_ID!,
    client_secret: process.env.CRONOFY_CLIENT_SECRET!,
    token: decrypt(connection.refreshToken),
  });

  // Remove from DB
  await db.delete(calendarConnections).where(eq(calendarConnections.expertId, expertId));
  await db.delete(calendarSubCalendars).where(eq(calendarSubCalendars.connectionId, connection.id));
}
```

---

## Token Encryption Pattern

Tokens must be encrypted at rest. Use AES-256-GCM:

```typescript
// lib/encryption.ts
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'); // 32-byte key as hex

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
```

Generate key: `openssl rand -hex 32`
