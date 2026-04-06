---
name: cronofy
description: >
  Integration patterns for Cronofy calendar API within Balo. Use this skill whenever
  implementing or modifying any calendar-related feature: expert calendar connection
  (OAuth flow), listing sub-calendars, registering push notification channels,
  handling change webhooks to update availability cache, fetching live free/busy slots
  for the expert profile page, writing or deleting consultation events, and implementing
  Availability Rules for the weekly schedule editor (BAL-195). Also covers token
  storage, refresh logic, and error handling patterns. Trigger on any mention of
  Cronofy, calendar sync, OAuth calendar, availability, free/busy, push notification
  channel, calendar events, or availability rules.
---

# Cronofy Integration Skill

## Balo-Specific Context

Cronofy is Balo's calendar infrastructure for V1. It handles:

- **OAuth connection** — expert connects Google / Outlook calendar via Cronofy Individual Connect
- **Sub-calendar listing** — surfaces all calendars (Work, Personal, etc.) for the conflict-check toggle UI
- **Push notifications** — Cronofy notifies Balo's webhook when an expert's calendar changes
- **Availability cache update** — on push notification, Balo recalculates and stores `earliest_available_at` per expert (one DB row, not full event sync)
- **Live free/busy fetch** — when a client views an expert's profile, Balo calls Cronofy free/busy for the next 60 days to populate the slot picker
- **Event write** — when a consultation is booked, Balo creates a calendar event on the expert's primary calendar
- **Event delete** — when a consultation is cancelled, Balo deletes the calendar event
- **Availability Rules** — expert's weekly schedule (BAL-195) is stored as a Cronofy Availability Rule and applied to free/busy queries

**Stack:** TypeScript, Fastify (backend on Railway), Drizzle ORM, BullMQ + Redis  
**Data center:** `api-au.cronofy.com` (Australia — confirm in Cronofy dashboard SDK Identifier)  
**SDK:** `cronofy` npm package (`pnpm add cronofy`)

---

## Architecture Summary

```
Expert connects calendar
    → OAuth callback → exchange code → store access_token + refresh_token in DB
    → List calendars → save sub-calendar list + user's sub
    → Register push notification channel (one per expert)

Calendar changes externally
    → Cronofy fires POST to /webhooks/cronofy
    → BullMQ job: recalculate earliest_available_at for expert
    → Update availability_cache table

Client views expert profile
    → Render page immediately (bio, rate, etc.)
    → Async: call Cronofy free/busy API (next 60 days, respect Availability Rules)
    → Populate slot picker when resolves (~500ms)
    → Redis cache: 5-min TTL keyed by expert_id + date

Expert saves day overrides (holiday, leave)
    → Stored in Balo DB as availability_overrides (start_date, end_date)
    → Applied FIRST during slot calculation — supersedes rules and calendar
    → BullMQ job triggered to rebuild earliest_available_at cache

    → Write event to expert's primary calendar via Cronofy upsertEvent
    → Store external_event_id on consultation record

Consultation cancelled
    → Delete event via Cronofy deleteEvent using stored external_event_id
```

---

## Reference Files

Read the relevant reference file before implementing any feature:

| Task                                           | Reference File                     |
| ---------------------------------------------- | ---------------------------------- |
| OAuth connect / token exchange / refresh       | `references/oauth.md`              |
| List calendars + sub-calendar toggle logic     | `references/calendars.md`          |
| Push notifications — register + handle webhook | `references/push-notifications.md` |
| Free/busy fetch + Redis cache pattern          | `references/free-busy.md`          |
| Write / delete consultation events             | `references/events.md`             |
| Availability Rules (BAL-195 weekly schedule)   | `references/availability-rules.md` |
| Date overrides — holidays, leave, block days   | `references/overrides.md`          |
| Timezone storage + timezone change handling    | `references/timezone.md`           |
| Error handling + token expiry recovery         | `references/errors.md`             |

---

## SDK Initialisation

```typescript
// apps/api/src/lib/cronofy.ts
import Cronofy from 'cronofy';

// App-level client (no access token) — used for token operations
export const cronofyApp = new Cronofy({
  client_id: process.env.CRONOFY_CLIENT_ID!,
  client_secret: process.env.CRONOFY_CLIENT_SECRET!,
  data_center: process.env.CRONOFY_DATA_CENTER!, // e.g. "api-au"
});

// Per-user client — used for calendar operations
export function cronofyUser(accessToken: string) {
  return new Cronofy({
    client_id: process.env.CRONOFY_CLIENT_ID!,
    client_secret: process.env.CRONOFY_CLIENT_SECRET!,
    data_center: process.env.CRONOFY_DATA_CENTER!,
    access_token: accessToken,
  });
}
```

**Environment variables required:**

```
CRONOFY_CLIENT_ID=
CRONOFY_CLIENT_SECRET=
CRONOFY_DATA_CENTER=api-au    # or api-us, api-uk, etc.
CRONOFY_REDIRECT_URI=https://api.balo.expert/auth/cronofy/callback
CRONOFY_WEBHOOK_SECRET=       # for verifying push notification authenticity
```

---

## DB Schema (Drizzle)

```typescript
// calendar_connections table
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertId: uuid('expert_id')
    .notNull()
    .references(() => experts.id),
  cronofySub: text('cronofy_sub').notNull(), // Cronofy account sub
  accessToken: text('access_token').notNull(), // encrypted at rest
  refreshToken: text('refresh_token').notNull(), // encrypted at rest
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  status: text('status').notNull().default('connected'), // connected | auth_error
  lastSyncedAt: timestamp('last_synced_at'),
  channelId: text('channel_id'), // push notification channel
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// calendar_sub_calendars table
export const calendarSubCalendars = pgTable('calendar_sub_calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => calendarConnections.id),
  calendarId: text('calendar_id').notNull(), // Cronofy calendar_id
  name: text('name').notNull(),
  provider: text('provider').notNull(), // google | outlook
  isPrimary: boolean('is_primary').notNull().default(false),
  conflictCheck: boolean('conflict_check').notNull().default(true),
  color: text('color'),
});

// availability_cache table (one row per expert — NOT full event sync)
export const availabilityCache = pgTable('availability_cache', {
  expertId: uuid('expert_id')
    .primaryKey()
    .references(() => experts.id),
  // TIMESTAMPTZ (not plain timestamp) — stored as UTC, unambiguous across timezones
  earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
```

**Critical:** Access tokens and refresh tokens must be encrypted at rest. Use AES-256 encryption with a key from env before storing.

**Critical:** All `timestamp` columns should use `{ withTimezone: true }` (`TIMESTAMPTZ` in Postgres). Plain `TIMESTAMP WITHOUT TIME ZONE` is ambiguous and causes bugs when experts span timezones.

**Expert timezone:** The `experts` table must have a `timezone` column (IANA string, e.g. `"Australia/Melbourne"`). Used in three places: Availability Rule `tzid`, override date expansion, and cache rebuild on timezone change. See `references/timezone.md`.

---

## Key Constraints & Gotchas

1. **Token expiry** — access tokens expire in ~14 days. Always check `token_expires_at` before use and refresh proactively. See `references/errors.md`.
2. **One push channel per expert** — Cronofy allows 128 per account but one is correct. Close old channels before creating new ones on reconnect.
3. **Data center matters** — all API calls must go to the same data center as the account. Wrong data center = 401. Use `CRONOFY_DATA_CENTER` env var consistently.
4. **Availability Rules are per-sub** — they're stored on the Cronofy account, not on Balo's DB. Use a stable `availability_rule_id` (e.g. `"balo_work_hours"`) so upsert is idempotent.
5. **Free/busy only, not event details** — Balo never reads event titles or descriptions. Use the `/v1/free_busy` endpoint, not `/v1/events`. Privacy by design.
6. **60-day forward window** — cap all free/busy queries to `now → now + 60 days`. No need to query further.
7. **Overrides are Balo-side, not Cronofy** — date overrides stored in `availability_overrides`, applied first in slot calculation. See `references/overrides.md`.
8. **Primary calendar for writes** — consultation events written to primary calendar only.
9. **Timezone changes require immediate cache rebuild** — update Availability Rule `tzid` in Cronofy and enqueue cache rebuild. Stale cache shows slots calculated against wrong timezone. See `references/timezone.md`.

---

## Real-World Gotchas (from Balo Support History)

Hard-won knowledge from actual Cronofy support tickets (Jan–Nov 2025). Read before implementing any calendar feature.

### G1. Initial Sync Pending — Most Common Failure

When a user completes OAuth but doesn't grant all required scopes, Cronofy enters `initial_sync_pending` state and returns no calendars.

**Symptoms:**
- `userinfo.profiles[0].profile_initial_sync_required === true`
- No calendars in userinfo output
- Cronofy telemetry shows `403 Request had insufficient authentication scopes`

**Root cause:** In some Google environments, calendar permissions are toggles the user must manually enable during OAuth — they are not auto-checked. Fast-clicking users miss them.

**Fix:** Always check `profile_initial_sync_required` immediately after the OAuth callback. If `true`, set `status = 'sync_pending'` and return the expert's profile relink URL rather than treating the connection as complete. See `references/oauth.md` for the full post-callback check.

### G2. Link Tokens Expire in 5 Minutes

The `link_token` parameter in Cronofy's auth flow is only valid for **5 minutes**. Never generate one in advance, store it in session, or cache it. Generate fresh immediately before the redirect.

### G3. `avoid_linking: true` Is Mandatory in Auth URL

Cronofy uses a browser cookie to merge multiple calendar authorizations made in the same session into one Cronofy account. Without `avoid_linking`, two different experts connecting from the same browser (common in dev/testing, or shared devices) will have their calendars merged under a single `sub`.

**Always** include `avoid_linking: true` in `generateAuthorizationUrl`. See `references/oauth.md`.

**If calendars are accidentally merged:** Only Cronofy support can separate them — there is no API for this. Email support@cronofy.com.

See [same-account-id FAQ](https://docs.cronofy.com/developers/faqs/same-account-id/) for how Cronofy's cookie-based linking works, and [Authorization Linking (alpha)](https://docs.cronofy.com/developers/api-alpha/explicit-linking/) for the deterministic alternative.

### G4. Revoke ≠ Delete — You Cannot Remove Calendar Profiles via the API

Calling `revokeAuthorization` ([docs](https://docs.cronofy.com/developers/api/authorization/revoke/)) removes the access token for Balo's platform but the calendar profile stays on the Cronofy account. Only Cronofy support can permanently remove a calendar profile. This is by design — it allows re-authorization without a full re-sync.

**Implication:** Revoking then re-authorizing re-uses the existing profile; it does not start fresh.

### G5. Availability Rules Survive Revocation

Availability Rules persist on the Cronofy account after authorization is revoked. This is usually desirable (expert's working hours haven't changed). On offboarding, explicitly delete rules before or after revoking. See `references/availability-rules.md` for the delete pattern and the [Availability Rules API docs](https://docs.cronofy.com/developers/api/scheduling/availability-rules/).

**Edge case:** If the access token is lost before cleanup (e.g. expert deleted from Balo DB), you need to re-authorize to get a token before you can delete the rules.

### G6. Availability API Always Returns UTC

The Availability Query API returns slots in UTC only. There is no timezone parameter for the response. The frontend must convert slots to the viewer's local timezone. See `references/timezone.md`.

### G7. `zoneinfo` Is Best-Effort — Don't Treat It as Authoritative

The `zoneinfo` field from Cronofy's userinfo/account endpoints is an IANA timezone string, but not all providers expose it. When unavailable, Cronofy defaults to `Etc/UTC`. Use it as a hint to pre-populate the expert's timezone during onboarding — do not rely on it as the ground truth. The expert should confirm their timezone explicitly in the UI.

### G8. Push Notification Channels Are All-or-Nothing

You cannot subscribe to only specific notification types (e.g. only `profile_disconnected`). Once a channel is created, you receive ALL notification types: `change`, `profile_disconnected`, `profile_connected`, `verification`. Filter by `notification.type` in the webhook handler. See `references/push-notifications.md`.

**Testing:** Trigger test push notifications from the Cronofy dashboard: Developer → Applications → your app → Channels tab → search by account ID → send test. Use this instead of waiting for real calendar activity.

### G9. Bulk Availability — Use One Multi-Participant Call, Not 50 Individual Calls

The Availability API supports querying multiple participants in a single request. Use `required: 1` under `participants` ([docs](https://docs.cronofy.com/developers/api/scheduling/availability/#param-participants.required)) to find slots where at least one expert is available:

```typescript
const { slots } = await cronofyApp.availability({
  participants: [
    {
      required: 1, // At least 1 expert must be free
      members: expertSubs.map(sub => ({ sub, managed_availability: true })),
    },
  ],
  required_duration: { minutes: 30 },
  query_periods: [{ start: startUtc, end: endUtc }],
});
```

This is the correct pattern for the expert search/filter feature. Default rate limits are 50 req/sec / 500/min — batching avoids hitting them.

### G10. GDPR Deletion Requires Emailing Cronofy Support

`revokeAuthorization` does not delete the user's data from Cronofy. See [Cronofy data management policy](https://docs.cronofy.com/policies/data-management/). For a full GDPR deletion:
1. Revoke the user's authorization via API
2. Email support@cronofy.com with the user's email and request permanent data deletion

Cronofy support will delete the account and all associated data. **Store `cronofySub` in Balo's DB even after an expert is soft-deleted**, so you can reference it in deletion requests.

### G11. Office 365 — IT Admin Approval Required for First User

When an expert with a work/school O365 account connects via Individual Connect:
- The **first user** from their organization will see a Microsoft Entra "admin approval required" screen
- An IT admin must approve the Cronofy Entra app for their tenant once
- After that, all users on that domain connect without admin intervention
- There is no API to check approval status

**UX:** Surface a message explaining the one-time IT admin step if the user encounters the approval screen.

**EWS / Application Impersonation is deprecated:** Microsoft announced this Feb 20, 2024; Cronofy added the warning to their docs Oct 14, 2024. Do not implement EWS flows — use Graph API (Individual Connect) only.

See [admin approval FAQ](https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/) for the exact screen users see and the admin consent link format.

### G12. Event Attendees — Invitation Emails Are Sent by the Calendar Provider

Invitation emails to attendees are sent by Google/Outlook, not Cronofy. Cronofy has no control over delivery. Add attendees via the `attendees` param in `upsertEvent`.

**Duplicate invitations:** If an expert has multiple Google profiles connected under the same Cronofy account (e.g. personal Gmail + work Gmail), the calendar provider may send duplicate invitations. Experts should only connect their primary/work calendar.

### G13. Rate Limit Increase Requires Emerging Plan + Engineering Approval

To increase the default limits (50 req/sec / 500/min), you must: (a) be on the Emerging plan and (b) provide a use case for Cronofy engineering to review. See [rate limits FAQ](https://docs.cronofy.com/developers/faqs/rate-limits/). Use the multi-participant Availability API (G9) before requesting a limit increase.

### G14. Brand the OAuth Flow Before Launch

The Cronofy OAuth screen shows Cronofy branding by default. Configure before go-live: Cronofy dashboard → Developer → Applications → your app → Branding dashboard. Set company name and logo so experts see "Balo" during the calendar connection flow.

### G15. Multiple Calendars on One Account — Conflict Detection Is the Right Behaviour

If an expert connects two Google accounts (e.g. work + personal) in the same browser session, both land in the same Cronofy `sub`. This is expected and useful — Balo can check both for conflicts via the `conflictCheck` toggle. The issue only arises when two **different** experts share a browser session, which `avoid_linking: true` (G3) prevents.
