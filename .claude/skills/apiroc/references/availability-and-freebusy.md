# Availability & free/busy — how Balo computes a bookable slot

This file is the **how** behind SKILL.md's Constraints 3–6 ("There is no delta key", "Free/busy only
for availability", "Slot rules are ours", "Forward window"). SKILL.md tells you what the vendor does
and why Balo reads it the way it does; this file tells you which shipped module does what, in what
order, with what signature, and which invariant fails the build when you get it wrong. Read it before
touching anything under `apps/api/src/services/availability/`, the availability BullMQ job, the
booking gate on `POST /meetings`, or the weekly-rule / time-off tables. Cross-references to SKILL.md
are by section name — the provider-parity table and the hypothesis ledger are not reproduced here,
though the parity rows that specifically bite a free/busy adapter are expanded in
[§3](#3-vendor-busyts--the-one-port).

Evidence tags carry SKILL.md's meaning: **[live]** observed against the real API in the BAL-393
spike, **[stat]** read out of the SDK bundle, **[docs]** vendor documentation only. Untagged prose is
a Balo design rule. Ticket numbers mark as-built versus not-yet-built; nothing below describes code
that does not exist without saying so.

---

## 1. What is built today, and what is not

The availability engine is **fully built and live except for its vendor edge**. Everything that
subtracts, merges, clips, caches and gates is shipped and tested; the one thing that reaches a
calendar vendor is a port whose live implementation returns `[]`.

| Piece                                          | Ticket            | State                                                  |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------ |
| Weekly rules table + repository                | BAL-195 / BAL-234 | **Shipped, live**                                      |
| Date overrides (time off) table + repository   | BAL-235           | **Shipped, live**                                      |
| Pure resolver (`resolve`)                      | BAL-243           | **Shipped, live**                                      |
| Booking gate (`isWindowBookable`)              | BAL-129           | **Shipped, live** on `POST /meetings`                  |
| Shared row projections + consultation load pad | BAL-129           | **Shipped, live**                                      |
| Vendor free/busy **port**                      | BAL-129           | **Shipped, returns `[]`** — no vendor behind it        |
| `availability_cache` + BullMQ rebuild job      | BAL-243           | **Shipped, live**                                      |
| Cache rebuild on every meeting mutation        | BAL-428           | **Shipped, live**                                      |
| Sync-capability matrix + delta-sync guard      | BAL-447           | **Shipped, inert by design** (a ruling, not machinery) |
| Apiroc SDK adapter boundary (`callApiroc`)     | BAL-467           | **Shipped, inert** — no caller yet                     |
| An actual `freeBusy.get` call                  | BAL-396           | **NOT BUILT**                                          |
| Per-slot picker / slot-grid surface            | —                 | **NOT BUILT** — see the divergence note in §2          |

> ⚠ **SKILL.md's Architecture Summary describes the target, not the tree.** Its "Client views expert
> profile → `freeBusy.get` → union busy intervals → slot calculator → Redis cache" line is BAL-396's
> plan. What ships today calls no vendor, unions nothing, and has no Redis slot cache: the only cache
> is one Postgres row per expert holding a single `earliest_available_at` (§6).

---

## 2. The pipeline, as built

There are **two reads of the same data, answering two different questions**, and the whole design of
this directory is about stopping them from disagreeing:

- **ADVERTISE** — `resolveAndCacheAvailability` → "when is this expert next free?" Writes
  `availability_cache.earliest_available_at`. Bounded by a **14-day display horizon**.
- **ACCEPT** — `isWindowAvailableForExpert` → "may THIS exact window be booked?" Writes nothing.
  Bounded by the **365-day booking horizon** enforced upstream by `validateBookingWindow`.

```
WRITE TRIGGERS (anything that can move an expert's calendar)
  · calendar change webhook       routes/calendar/webhook.ts       (Cronofy today; Apiroc = BAL-396)
  · schedule editor save/clear    routes/experts/schedule.ts       (3 call sites)
  · time-off create/delete        routes/experts/availability-overrides.ts (2 call sites)
  · book / reschedule / cancel /  services/meetings/meeting-availability.ts (BAL-428)
    soft-delete a meeting
  · staleness cron every 15 min   jobs/availability-cache.ts  (lastSyncedAt older than 15 min)
        │
        ▼
  enqueueAvailabilityCacheRebuild(expertProfileId, log)
        │  jobId: `availability-${expertProfileId}`   ← coalesces every trigger into ONE pending job
        ▼
  BullMQ queue 'rebuild-availability-cache'  (worker concurrency 5)
        │
        ▼
  resolveAndCacheAvailability(expertProfileId)                  [ADVERTISE — impure adapter]
        ├── expertsRepository.findResolverSettings              tz + buffers + minimum notice
        ├── availabilityRulesRepository.listByExpertProfileId   weekly rules (BAL-195)
        ├── consultationsRepository.listConfirmedInRange        [now−1d, horizonEnd+1d]
        ├── availabilityOverridesRepository.listUpcoming        time off (BAL-235)
        └── vendorBusyProvider.listBusyBlocks(id, from, to)     ← THE ONLY VENDOR SEAM (returns [])
              │
              ▼
        resolve({ rules, baloConsultations, busyBlocks, overrideBlocks, tz, now,
                  horizonDays, minMinutes, buffers, notice })  [PURE]
              │
              ▼
        calendarRepository.upsertAvailabilityCache(expertProfileId, earliestAvailableAt)

READ (what a client actually sees today)
  GET /experts/search  →  expertSearchRepository
        · LEFT JOIN availability_cache ac
        · gate  (env EXPERT_SEARCH_AVAILABILITY_GATE === 'on'):
              ac.earliest_available_at IS NOT NULL AND > now
        · sort  'soonest' / 'best_match' → ac.earliest_available_at ASC NULLS LAST
        · filter 'timeframe' → ac.earliest_available_at <= now + N days
  expert card → computeAvailability(nextAvailableAt, now)   ("Available now" / "Free in ~3h" / …)

BOOK
  POST /meetings
        1. validateBookingWindow(start, end, now)      @balo/shared/meetings — SHAPE only
        2. authorizeMeetingBooking(...)                tenancy / capability
        3. per-(user,expert) rate limit
        4. isWindowAvailableForExpert(expertProfileId, start, end, now)   [ACCEPT — impure adapter]
              ├── the SAME four loads as above, over [start−1d, end+1d]
              └── isWindowBookable({ … start, end })   [PURE — shares every interval primitive]
           false → 409 { error: 'window_not_available' }   ⚠ fixed literal, never a reason
        5. bookMeeting(...) → writes the consultations projection → enqueues the rebuild
```

### Module table

| Module (`apps/api/src/services/availability/`) | Purity | Exported surface                                                                                                         |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`                                     | types  | `ResolverRule`, `ResolverConsultation`, `BusyBlock`, `ResolverInput`, `ResolverResult`, `WindowBookableInput`            |
| `resolver.ts`                                  | PURE   | `resolve(input: ResolverInput): ResolverResult` · `isWindowBookable(input: WindowBookableInput): boolean`                |
| `resolver-inputs.ts`                           | PURE   | `CONSULTATION_LOAD_PAD_MS` · `toResolverRules` · `toResolverConsultations` · `expandOverrideBlocks(overrides, timezone)` |
| `vendor-busy.ts`                               | port   | `interface VendorBusyProvider` · `const vendorBusyProvider`                                                              |
| `resolve-and-cache.ts`                         | impure | `resolveAndCacheAvailability(expertProfileId, options?): Promise<{ earliestAvailableAt: Date \| null }>`                 |
| `window-availability.ts`                       | impure | `isWindowAvailableForExpert(expertProfileId, start, end, now): Promise<boolean>`                                         |

The pure/impure split is load-bearing: `resolve` and `isWindowBookable` read **no DB, no env, no
clock, and never log** — `now` is always injected. That is why every rule below can be tested as a
table of literals (§8).

---

## 3. `vendor-busy.ts` — the one port

```typescript
// apps/api/src/services/availability/vendor-busy.ts
import type { BusyBlock } from './types.js';

export interface VendorBusyProvider {
  listBusyBlocks(expertProfileId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

/** THE LIVE IMPLEMENTATION — `[]` until a vendor is wired. */
export const vendorBusyProvider: VendorBusyProvider = {
  listBusyBlocks(): Promise<BusyBlock[]> {
    return Promise.resolve([]);
  },
};
```

**Why it exists, in one sentence:** vendor free/busy was the only resolver input that is a _fetch_
rather than a _row projection_, so it escaped the `resolver-inputs.ts` extraction and each of the two
reads defaulted it to its own inline `[]` — meaning a vendor wired at the ADVERTISE call site would
have left the ACCEPT gate double-booking over an expert's real external commitments **with no type,
no test and no helper failing**. A shared literal would only be a grep target; a shared port is a
compile dependency.

### The rules

1. **Every availability path reaches a calendar vendor through `vendorBusyProvider.listBusyBlocks`
   and nowhere else.** Not through the job, not through a route, not through a second provider object
   keyed on the caller.
2. **It reads a WINDOW, never a delta.** `[from, to)` is whatever the caller needs answered — the
   whole forward horizon for advertise, one padded booking window for accept. An implementation must
   not assume either shape, and must not carry a cursor (§7).
3. **The only sanctioned divergence is `ResolveAndCacheOptions.busyBlocks`**, a seed/test-only
   override used by `services/seed/seed-service.ts`. When supplied the port is not consulted at all,
   so in a seeded environment the advertised answer accounts for synthetic blocks and the booking
   gate does not. That is why "advertise and accept agree" is a claim about **production**.
4. **Return a fresh array each call** — both call sites spread it into
   `[...busyBlocks, ...overrideBlocks]`, and a returned singleton is exactly what a later caller
   mutates in place. Pinned by `vendor-busy.test.ts`.

### What a real implementation must normalise (the parity items that bite availability)

Expanding only the rows of SKILL.md's **Provider-parity table** that a free/busy adapter touches. All
**[live]** from BAL-393.

| Divergence                 | Google                 | Microsoft                  | What the port must do                                                                                                                                                                                                              |
| -------------------------- | ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busySlots` timezone label | `UTC`                  | `Etc/UTC`                  | Never string-compare a tz name. `BusyBlock` is two **UTC `Date` instants**; convert at the boundary and drop the label.                                                                                                            |
| `dateTime` precision       | `2026-08-20T10:00:00Z` | `2026-08-20T10:00:00.000Z` | Parse, never string-compare or dedupe on the raw string.                                                                                                                                                                           |
| Response envelope          | bare array             | bare array                 | ⚠ `freeBusy.get` returns **`FreeBusySlot[]`**, not the `{ data }` envelope every list endpoint uses. A `res.data` read is `undefined`, which silently becomes "no busy blocks" — i.e. an expert bookable over their real calendar. |
| Calendar `timeZone` field  | populated              | **absent**                 | Never source the expert's timezone from the vendor; it is `expert_profiles.timezone` (§4).                                                                                                                                         |
| Calendar id format         | email address          | 152-char opaque Graph id   | URL-encode anywhere you build a path by hand (the SDK does `encodeURIComponent` **[stat]**).                                                                                                                                       |

Two further constraints on the future implementation, both from SKILL.md:

- **Privacy (Constraint 4):** availability comes from `freeBusy.get` — busy slots, no titles. A full
  event read on this path is banned and the ban is enforced (§7).
- **Errors (BAL-467):** go through `callApiroc('freeBusy.get', () => …)` from
  `apps/api/src/lib/apiroc/`, which normalises the SDK's mangled error into an `ApirocError` with a
  `kind` and the `x-request-id` attached. `classifyRetry(err)` is the shipped retry table —
  `validation`/`unauthorized`/`forbidden`/`not_found`/`unknown` never retry; `rate_limited` honours
  `Retry-After` (default 5000 ms); `server_error` and `network` retry. ⚠ `callApiroc` wraps
  **exactly one** SDK call — a `Promise.all` fan-out across an expert's provider accounts must
  normalise per call, not around the whole `Promise.all` (§5).

---

## 4. The rule layer: how a free window is computed

`resolve()` is nine steps, in this order. Anything you add belongs in one of them, not beside them.

```typescript
// apps/api/src/services/availability/resolver.ts — the spine of resolve(), faithfully reduced
const { rangeStart, rangeEnd } = boundWindow(now, horizonDays, minimumNoticeMs);
if (rangeStart >= rangeEnd) return { earliestAvailableAt: null };

const rulesByDow = groupRulesByDayOfWeek(rules);
if (rulesByDow.size === 0) return { earliestAvailableAt: null }; // no schedule ⇒ never bookable

const expanded = expandRulesInRange(rulesByDow, rangeStart, rangeEnd, timezone);
const clipped = clipToWindow(expanded, rangeStart, rangeEnd);
if (clipped.length === 0) return { earliestAvailableAt: null };

const merged = mergeOverlapping(clipped);
const busy = combineBusyIntervals(
  baloConsultations,
  [...busyBlocks, ...overrideBlocks], // vendor busy + time off, folded into ONE set
  bufferBeforeMs,
  bufferAfterMs
);

const free: BusyBlock[] = [];
for (const window of merged) free.push(...subtractBusy(window, busy));

const longEnough = free.filter(
  (w) => w.endAt.getTime() - w.startAt.getTime() >= minMinutes * 60_000
);
longEnough.sort(compareByStart);
return { earliestAvailableAt: longEnough[0] ? laterOf(longEnough[0].startAt, now) : null };
```

### Subtraction semantics

- **One busy set, no precedence.** Confirmed consultations, vendor busy blocks and expanded date
  overrides are concatenated, padded, and sorted once. Interval set-difference is order-independent
  (`W ∖ A ∖ B === W ∖ (A ∪ B)`), so there is no "override beats consultation" rule to get wrong —
  and no place to add one.
- **Subtraction is per open window**: `subtractBusy(window, busy)` yields 0..N sub-windows;
  `subtractBusyFromSegment` splits a segment into at most two pieces. Busy is pre-sorted, so the
  loop `break`s once a busy interval starts after the window ends.
- **Merging happens on rule windows only** (`mergeOverlapping`), so two adjacent published rules
  (09–12 and 12–17) are one continuous window and an 11:00–13:00 booking spans both.

### Padding, notice, duration floors, and the two horizons

| Knob                        | Source                                                      | Applied where                                                               | Default  |
| --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| `bufferBeforeMinutes`       | `expert_profiles.booking_buffer_before_minutes`             | grows **every** busy interval's start (`combineBusyIntervals`)              | 0        |
| `bufferAfterMinutes`        | `expert_profiles.booking_buffer_after_minutes`              | grows **every** busy interval's end                                         | 0        |
| `minimumNoticeMinutes`      | `expert_profiles.booking_minimum_notice_minutes`            | pushes `rangeStart` forward (advertise) / rejects an early `start` (accept) | 0        |
| `minMinutes`                | option → `MIN_CONSULTATION_MINUTES` env → `15`              | discards sub-windows too short to ADVERTISE                                 | 15       |
| `horizonDays`               | option → `RESOLVER_HORIZON_DAYS` env (must be `> 0`) → `14` | bounds the earliest-available SCAN                                          | 14       |
| `MIN`/`MAX_MEETING_MINUTES` | `@balo/shared/meetings`                                     | one window's duration, in `validateBookingWindow`                           | 15 / 480 |
| `MAX_BOOKING_HORIZON_DAYS`  | `@balo/shared/meetings`                                     | how far out a booking may be, in `validateBookingWindow`                    | 365      |

All four per-expert knobs come from one read:

```typescript
// packages/db/src/repositories/experts.ts
expertsRepository.findResolverSettings(expertProfileId): Promise<{
  timezone: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
} | null>;
```

⚠⚠ **`WindowBookableInput` deliberately carries NO `horizonDays` and NO `minMinutes`.** The 14-day
display horizon bounds a _scan_; the booking horizon is 365 days and is enforced upstream. Applying
the display horizon in the accept path would refuse every legitimate booking more than a fortnight
out — `window-bookable.test.ts` pins a booking 300 days out as valid. Likewise the proposed window's
own duration floor is `MIN_MEETING_MINUTES`, not `minMinutes`.

⚠ **SKILL.md's Constraint 6 says "carry the 60-day convention".** No 60-day value exists anywhere in
the shipped code: the advertise horizon is **14** days (`DEFAULT_HORIZON_DAYS`, overridable by
`RESOLVER_HORIZON_DAYS`) and the booking horizon is **365** (`MAX_BOOKING_HORIZON_DAYS`). Size a
`freeBusy.get` window off the range the port is actually handed, never off a number in prose.

⚠ **Neither `horizonDays` nor `minMinutes` is a per-expert column, and there is no slot
_granularity_ concept at all.** The engine emits free _intervals_ and an earliest instant; it never
slices them into 15-/30-minute offer points. If a slot grid ships, granularity is a new rule in
step 8, not a new column.

### The consultation load pad — correctness, not slack

```typescript
// apps/api/src/services/availability/resolver-inputs.ts
export const CONSULTATION_LOAD_PAD_MS = 24 * 60 * 60 * 1000;
```

Both reads pad the consultation query by one day on **both** sides (`[now − pad, horizonEnd + pad]`
and `[start − pad, end + pad]`). Because `combineBusyIntervals` grows every busy interval by the
buffers, a consultation ending just before the range can still overlap once padded. Before BAL-129
the accept path padded and the advertise path did not, so any expert with
`booking_buffer_after_minutes > 0` could be advertised a slot the booking gate then refused with a 409. If you change one range predicate, change the constant — never one call site.

### Timezone and DST — the part that is easy to break

Rules are **wall-clock times in the expert's own timezone** (`availability_rules.start_time` /
`end_time` are Postgres `time`, which Drizzle returns as `'09:00:00'` strings). Nothing is stored in
UTC and nothing is derived from the vendor's calendar `timeZone` field (absent on Microsoft).

```typescript
// expandRuleOnDate — one rule, one local date, two independent UTC conversions
const crossesMidnight = endTime < startTime; // string compare of 'HH:mm:ss', deliberately
const endDateStr = crossesMidnight ? formatDateOnly(nextLocalDate) : startDateStr;
const utcStart = fromZonedTime(`${startDateStr}T${startTime}`, timezone);
const utcEnd = fromZonedTime(`${endDateStr}T${endTime}`, timezone);
```

- **Per-date expansion, not a fixed offset.** `expandRulesInRange` iterates _local_ dates
  (`dateCursor.setDate(+1)`), so one `dayOfWeek: 0` rule resolves to UTC+11 on the Sunday before a
  Sydney DST transition and UTC+10 on the Sunday after. Both directions are pinned by tests.
- **Each endpoint converts against its own date**, so a crossing-midnight window over a
  spring-forward night is genuinely one hour shorter (22:00 AEST → 06:00 AEDT is 7 real hours).
- **The cursor steps back one local day** before iterating, so a Monday-anchored 22:00→02:00 rule
  still covers Tuesday 00:00–02:00. `clipToWindow` trims anything ending at or before `rangeStart`,
  so same-day rules are unaffected.
- **Non-existent local times resolve leniently.** `fromZonedTime` v3 interprets a wall-clock value in
  the skipped hour using the post-transition offset, which round-trips to an _earlier_ real local
  time (Sydney `2026-10-04T02:30` → `2026-10-03T15:30Z`, i.e. 01:30 AEST). Accepted for v1 and
  **locked by `resolver.test.ts > DST spring-forward`** — if `date-fns-tz` ever changes semantics
  that assertion breaks on purpose.
- **Date overrides are calendar dates, expanded in the expert's tz, end-INCLUSIVE:**

```typescript
// resolver-inputs.ts — endDate is INCLUSIVE, so the interval runs to midnight of the NEXT day
expandOverrideBlocks([{ startDate: '2026-09-07', endDate: '2026-09-07' }], 'Australia/Sydney');
// → [{ startAt: 2026-09-06T14:00Z, endAt: 2026-09-07T14:00Z }]
```

`nextDayIso` **throws** on a malformed date rather than returning the input: a zero-length interval
would silently drop the block and leave the expert bookable during their own leave.
`availabilityOverridesRepository.listUpcoming` filters `endDate >= CURRENT_DATE - INTERVAL '1 day'`
— one day wider than the naive predicate, to absorb ±1 day of tz skew for experts west of UTC.
Over-inclusion is free (an elapsed interval subtracts to nothing); under-inclusion un-blocks leave.

### Fail-closed points

`isWindowBookable` returns `false` — never "no constraints found, allow it" — for: a non-finite
`start`/`end`/`now` (the guard is **first**, because every later comparison is NaN-blind and
therefore permissive), an inverted or zero-length window, a start inside minimum notice, **no
published rules at all**, and a window that only _partially_ overlaps published availability (16:30–
17:30 against a 09:00–17:00 rule is refused, not trimmed). `isWindowAvailableForExpert` adds one
more: a missing expert profile or timezone returns `false` and logs a warning, without even reading
rules or consultations.

⚠ **It is a check, not a lock.** Two concurrent bookings of the same free slot can both pass — there
is no exclusion constraint on `consultations`. That residual is bounded by the same property that
makes the gate a DoS control: every success writes a `confirmed` consultation the next call reads as
busy, so the ceiling is the expert's own published calendar.

---

## 5. Union across providers, and the failure posture

**The rule** (ADR-1021 amendment 18 Aug 2026 / BAL-467 §1, quoted verbatim in both
`packages/db/src/schema/calendar.ts` and `packages/db/src/repositories/calendar.ts`): _"An expert may
hold connections to multiple providers at once; availability is the union of busy blocks across all
of the expert's connections."_ `calendar_connections` is unique on `(expert_profile_id, provider)`
partial on `deleted_at IS NULL`, and the reader the union needs already exists:

```typescript
// packages/db/src/repositories/calendar.ts — ⚠ INERT, no caller until BAL-396 wires free/busy
calendarRepository.listConnectionsByExpertProfileId(expertProfileId): Promise<CalendarConnection[]>;
// ⚠ NOT findConnectionByExpertProfileId — that returns ONE row (oldest live) and would silently
// ignore the expert's second calendar, double-booking them.
```

**What is actually built:** nothing unions anything. The port takes a single `expertProfileId` and
returns `[]`; there is no fan-out, no per-provider partial result, and **no shipped failure posture
to describe**. Stating that plainly matters more than inventing one — a builder who reads a posture
into this directory will find no code implementing it.

**What the current shape does do when a fetch rejects**, since the port returns a bare `Promise` that
both call sites put into a `Promise.all`:

| Path                                                            | On a rejected vendor read                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADVERTISE (`resolveAndCacheAvailability`, in the BullMQ worker) | The job fails → 3 attempts, exponential backoff from 2 s → `removeOnFail: true`, `worker.on('failed')` logs to Axiom/Sentry. The cache row is **left at its previous value**: stale, not cleared. |
| ACCEPT (`isWindowAvailableForExpert`, in `POST /meetings`)      | The rejection propagates out of `resolveBookingInput`, which sits **outside** the route's `try` — so it reaches Fastify's error handler as a **500**, not the clean `409 window_not_available`.   |

So the accept path fails closed (no booking is written) but it does so noisily and without a mapped
error code. **BAL-396 owns the real decision** and must state it explicitly: whether one provider's
failed read means (a) refuse the whole answer, (b) proceed on the providers that answered, or (c)
serve the last good cache. Whatever it chooses, it belongs **inside the port implementation** so both
reads inherit it — and note that (b) plus `callApiroc`'s one-call contract means per-connection
normalisation, not one `callApiroc` around a `Promise.all` (§3).

---

## 6. The cache: `availability_cache`

```typescript
// packages/db/src/schema/calendar.ts
export const availabilityCache = pgTable(
  'availability_cache',
  {
    expertProfileId: uuid('expert_profile_id')
      .primaryKey()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    earliestIdx: index('availability_cache_earliest_idx').on(table.earliestAvailableAt),
  })
);
```

- **One row per expert, keyed by the expert. Not an event mirror, not a slot list, not a busy-block
  copy.** Nothing about the expert's actual calendar contents is ever persisted by Balo — which is
  Constraint 4's privacy posture expressed in the schema.
- **No `deleted_at`, no soft delete, no RLS** (matching the whole availability domain, which is
  admin-client-only behind WorkOS / `requireInternalAuth`). No `sync_token` column, and none planned.
- The index is hand-augmented to a **partial** index (`WHERE earliest_available_at IS NOT NULL`) in
  the migration — drizzle-kit cannot express the predicate, so the declaration above exists only to
  stop drizzle-kit re-dropping it. **The migration is the source of truth.**

### Writers

| Writer                                                 | Method                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `resolveAndCacheAvailability` (the only real one)      | `calendarRepository.upsertAvailabilityCache(id, earliestAvailableAt)` — `onConflictDoUpdate` on the PK              |
| `routes/calendar/webhook.ts` on `profile_disconnected` | `calendarRepository.clearAvailabilityCache(id)` — sets the row to `null` (the expert drops out of the gated search) |

### The job

```typescript
// apps/api/src/jobs/availability-cache.ts
export const AVAILABILITY_CACHE_QUEUE = 'rebuild-availability-cache';
export const STALENESS_CHECK_QUEUE = 'staleness-check';

await queue.add(
  'rebuild-availability-cache',
  { expertProfileId },
  {
    jobId: `availability-${expertProfileId}`, // ⇐ THE DEDUP KEY
    removeOnComplete: true,
    removeOnFail: true, // ⚠ a retained failed job would wedge this fixed jobId forever
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  }
);
```

- **`jobId` is fixed per expert**, so a burst of triggers (webhook coalescing + a schedule save + a
  booking) collapses into one pending rebuild. This is why the webhook can be a bare trigger.
- **`removeOnFail: true` is load-bearing, not tidiness.** With a fixed `jobId`, a _retained_ failed
  job blocks every later enqueue for that expert — permanently wedging their availability. Dropping
  it lets the next trigger self-heal; `worker.on('failed')` is the observability.
- **Enqueue never throws.** A Redis hiccup must not fail the caller's mutation, so
  `enqueueAvailabilityCacheRebuild` swallows and logs. ⚠ That means a booking can commit while its
  rebuild is silently lost — which is exactly what the staleness sweep and the next trigger repair.
- Worker `concurrency: 5`; emits `CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT` with
  `distinct_id: expertProfileId` (analytics stays in the worker, not in the service).

### How staleness is bounded

1. **Push** — a calendar-change webhook enqueues a rebuild (Cronofy today; Apiroc/Svix is BAL-396 /
   BAL-468). Apiroc coalesces rapid changes into roughly 10-second batches **[live]**.
2. **Mutation** — every meeting write rebuilds via `services/meetings/meeting-availability.ts`
   (BAL-428). `expertProfileId === null` (an `admin` meeting) rebuilds nobody, by design.
3. **Sweep** — `registerStalenessCheckCron` runs `*/15 * * * *`; the worker takes
   `findStaleConnections(now − 15 min)` (live `connected` connections whose `last_synced_at` is
   older than the threshold) and enqueues a rebuild for each.

So the bound is **~15 minutes plus one job**, and only for experts with a live calendar connection —
an expert with no connection is refreshed only by their own edits and by bookings. There is **no
TTL** on the row and no read-through refresh: a stale row is served as-is until something enqueues.

---

## 7. ⚠⚠ The delta-sync ban, in enforcement terms

SKILL.md Constraint 3 states the ruling. This section is what happens to you in CI.

**The ruling** (BAL-447 / ADR-1021 amendment 2026-08-15), quoted from the guard:

> Balo performs no calendar delta sync. For every provider, a calendar-change webhook is a bare
> trigger that enqueues a whole-window availability rebuild; availability is always recomputed from a
> windowed free/busy read via `vendorBusyProvider.listBusyBlocks`. `syncToken` / `nextSyncToken` is
> never read and never stored. There is no provider-conditional sync path.

### What `services/calendar/sync-capability.ts` encodes

It is **inert by design** — a shipped ruling, not machinery. Do not import it; read it.

```typescript
export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const; // apple/icloud deliberately absent
export const SYNC_STRATEGIES = ['full_window_reread'] as const; // SINGLE-MEMBER ON PURPOSE

export const SYNC_CAPABILITY_MATRIX = {
  google: {
    supportsSyncToken: true, // ← an OBSERVED VENDOR FACT
    deltaMechanism: 'events_list_sync_token',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread', // ← BALO'S RULING
    evidence: 'BAL-393 FINDINGS.md §P3 — nextSyncToken on the FINAL page only',
  },
  microsoft: {
    supportsSyncToken: false,
    deltaMechanism: 'none',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread',
    evidence: 'BAL-393 FINDINGS.md §M2 — never returned, any page, exhausted at pageSize=1',
  },
} as const satisfies Record<CalendarProvider, ProviderSyncCapability>;

/** Reads the matrix — and deliberately does NOT read `supportsSyncToken`. */
export function resolveSyncStrategy(provider: CalendarProvider): SyncStrategy {
  return SYNC_CAPABILITY_MATRIX[provider].baloSyncStrategy;
}
```

The two columns are **decoupled on purpose**: capability is an observation, strategy is a ruling, and
strategy is not a function of capability. `SYNC_STRATEGIES` is single-member so that introducing
provider conditionality is an edit to one pinned line. Adding a provider without a matrix row is a
**compile error** (`satisfies`).

### What `invariants/sync-token-parity.test.ts` fails the build for

Three layers, ~709 lines, every scan deriving its subjects from a **directory walk** (never a pinned
file list — a pinned list passes vacuously for exactly the future files that matter, and that opt-out
was empirically reproduced in review).

| Layer / Scan   | Subject                                                                                | Fails when                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — DATA**   | the matrix                                                                             | the Google/Microsoft divergence stops being recorded, or a row loses its `BAL-393` evidence (anchored by direction _and_ by §M2/§P3 refs)                                 |
| **2 — RULING** | `resolveSyncStrategy`, `SYNC_STRATEGIES`                                               | a second strategy appears, or the strategy stops being identical for every provider. ⚠ Flipping a boolean cannot make this pass or fail — only rewriting the resolver can |
| **3 / Scan A** | **all** of `apps/api/src` (exempt: the matrix file, `invariants/`)                     | any non-comment line anywhere contains `syncToken` / `SyncToken` / `sync_token`                                                                                           |
| **3 / Scan B** | `jobs/`, `services/availability/`, `services/calendar/` + `routes/calendar/webhook.ts` | a file names `google`/`microsoft`/`apple`/`icloud`, or contains `provider ===` / `switch (provider`                                                                       |
| **3 / Scan C** | `routes/calendar/webhook.ts`                                                           | `changes_since` occurs more than **once** (declared on the payload type, never read), or the handler stops calling `enqueueAvailabilityCacheRebuild`                      |
| **3 / Scan D** | `routes/calendar/types.ts`, `routes/calendar/auth.ts`                                  | the hand-written provider unions drift from `CALENDAR_PROVIDERS`                                                                                                          |
| **3 / Scan E** | Scan B's dirs **plus all of `routes/calendar/`**                                       | a file contains `events.list`, `updatedAfter` or `expandRecurrences`                                                                                                      |

Markers are matched against **raw source, line-classified** — a marker inside a string literal on a
code line trips the scan (a comment-_stripping_ version was fail-open: it truncated
`fetch('https://api.onecal.com/events', { headers: { syncToken: t } })` at the `//` inside the URL and
passed). Prose that merely names the construct does not trip it.

### Why "just add a syncToken for Google" is wrong

Three independent reasons; each alone is sufficient, and none is repaired by making Google a special
case:

1. **The cursor is on the wrong endpoint.** `syncToken` lives on `events.list`. Availability is
   sourced from `freeBusy.get`, which has **no delta mode on either provider**. A sync token cannot
   make a free/busy read incremental; it can only replace it with a different kind of read.
2. **That different read violates the privacy posture.** Constraint 4 is busy slots, no titles.
   Switching availability to full event reads to obtain deltas ships event _content_ into Balo for
   every expert, permanently, to save a windowed read. This is why **Scan E** bans
   `events.list`/`updatedAfter`/`expandRecurrences` on the availability path even though they contain
   no sync token: a timestamp-differenced `events.list(acct, cal, { updatedAfter: lastSyncedAt })` is
   the same rejected option in different clothing — and `calendar_connections.lastSyncedAt` already
   exists and is already written on every change webhook, so the ingredients are on the shelf.
   ⚠ It is also **blind to deletions**, so a cancelled meeting would never leave the cache.
3. **Capability is not uniform, so the "just" is a fork.** Microsoft never returns a token on any
   page (§M2, paginated to exhaustion at `pageSize=1`); Google returns one **only on the final page**,
   mutually exclusive with `nextPageToken` (§P3) — and the default page size is 400, so on every dev
   and test calendar the token appears on page 1 and the early-stop bug is invisible until a busy
   expert's real calendar. A Google-only delta path is a permanent provider-conditional branch in the
   sync path, plus a second source feeding the ADVERTISE read while ACCEPT still reads the port — the
   exact divergence `vendor-busy.ts` exists to make unrepresentable.

Full event reads remain sanctioned for **Balo's own tagged consultation events** (create / delete /
reconcile via `metadataFilters` on `baloBookingId`). Those do not live on the availability path.

**If you believe delta sync is now correct: amend ADR-1021 first.** The remedy for a red
`sync-token-parity.test.ts` is a decision, never a test edit or an allowlist entry.

---

## 8. Testing availability

The shipped suites encode the contract; copy their shape.

| File                                       | Kind        | What it pins                                                                                                              |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `resolver.test.ts`                         | pure unit   | every slot rule as literals: DST both directions, spring-forward gap, cross-midnight, buffers, notice, horizon, overrides |
| `window-bookable.test.ts`                  | pure unit   | the accept predicate: wholly-inside, straddle, adjacency, per-tz interpretation, degenerate inputs fail closed            |
| `resolver-inputs.test.ts`                  | pure unit   | the three row projections, end-inclusive override expansion, the `nextDayIso` throw                                       |
| `vendor-busy.test.ts`                      | pure unit   | `[]` for any input, and a **fresh array** each call                                                                       |
| `resolve-and-cache.test.ts`                | mocked unit | load ranges, env precedence, the shared port is consulted, the seed override bypasses it                                  |
| `window-availability.test.ts`              | mocked unit | fail-closed, padded loads, and that it reads the **same port object** and writes nothing                                  |
| `availability-cache.test.ts`               | mocked unit | queue names, the dedupe `jobId`, `removeOnFail`, enqueue never throws                                                     |
| `booking-availability.integration.test.ts` | integration | book → the slot disappears → cancel → it returns, against real Postgres                                                   |
| `invariants/sync-token-parity.test.ts`     | invariant   | the ban (§7)                                                                                                              |

### The patterns

- **Inject the clock; never mock it.** `resolve` / `isWindowBookable` take `now`. Every suite pins a
  literal instant (`2026-06-01T00:00:00.000Z` in the resolver suite, `2026-09-07T00:00:00.000Z` in
  the BAL-129 ones) and asserts literal expected instants — no arithmetic in the expectations.
- **Pin the timezone explicitly**, including in fixtures: the integration test sets
  `expert_profiles.timezone = 'UTC'` even though that is already the default, so the assertions do
  not depend on a column default that is free to change.
- **Derive fixture weekdays from the fixture dates** (`const WINDOW_DOW = START.getUTCDay()`) so an
  edited date cannot silently stop testing the intended day.
- **Never mock `./resolver.js` from an adapter test** — the pure decision logic is what the adapter
  exists to reach; mocking it leaves nothing under test but four call signatures. (Conversely
  `resolve-and-cache.test.ts` _does_ mock it, because its subject is the load/write wiring.)
- **Spy the port, don't mock the module.** Both adapter suites use
  `vi.spyOn(vendorBusyProvider, 'listBusyBlocks')`. A module mock would paper over the property under
  test — that both adapters read the _same object_.
- **Pass `horizonDays` and `minMinutes` explicitly** in any test that asserts an instant: both fall
  back to env vars, and an environment that set either would silently change every expectation.
- **⚠ Run vitest with `TZ=UTC`.** Some suites fail only on a non-UTC shell; CI is UTC. `apps/api`'s
  config is `environment: 'node'`, `include: src/**/*.{test,spec}.ts`, and — load-bearing —
  `exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts']`.
- **Integration tests in `apps/api` run from `packages/db/vitest.config.integration.ts`**, whose
  `root` is the repo root and whose `globalSetup`/`setupFiles` are absolute, so one testcontainer
  serves both packages and every write lands in the per-test transaction. ⚠ `pnpm test:integration`
  **passes vacuously without Docker** (`passWithNoTests: true` prints "No test files found" and exits 0) — check the reported test **count**, never the exit code.
- **Positive controls on any absence assertion.** The invariant suite proves each matcher fires
  before asserting it finds nothing; do the same for any new structural guard.

---

## 9. Checklist — changing a slot-calculation rule

1. **Name which question you are changing: ADVERTISE, ACCEPT, or both.** If the answer is "both",
   the change belongs in `resolver.ts` or `resolver-inputs.ts`, never edited into two adapters.
2. **Put it in one of the nine steps** (§4). A new busy _source_ is folded into the same
   order-independent set — do not introduce precedence between busy sources.
3. **Is it a row projection, a load range, or a fetch?** Projections → `resolver-inputs.ts`. Load
   ranges → `CONSULTATION_LOAD_PAD_MS` and both call sites together. Fetches → `vendor-busy.ts`, and
   only there.
4. **Keep the pure functions pure** — no DB, env, clock or logging in `resolver.ts`. If you need a
   platform number, thread it through `ResolverInput` from the adapter.
5. **Check the two horizons separately.** Anything you add to `ResolverInput` is _not_ automatically
   right for `WindowBookableInput`; `horizonDays`/`minMinutes` are display-only by design.
6. **Verify the advertise/accept pair by hand:** would this change make the platform advertise a slot
   the booking gate refuses (a user-visible 409), or accept one it shows as blocked? Write the test
   that would catch it.
7. **Do timezone work through `fromZonedTime` with an explicit local date string.** Add a DST case
   in both directions if you touched expansion, and do not "fix" the locked spring-forward assertion
   without a decision.
8. **Trigger the rebuild.** Any new mutation that can move an expert's calendar must call
   `enqueueAvailabilityCacheRebuild(expertProfileId, log)` post-commit — from `apps/api`, never from
   a web Server Action (the queue does not exist there, and `@balo/db` may not reach it).
9. **Re-read §7 before writing anything that touches the vendor.** Windowed read, no cursor, no
   provider branch, no event content — and run
   `TZ=UTC npx vitest run apps/api/src/invariants/sync-token-parity.test.ts` before you push.
10. **Keep the messaging opaque.** The booking refusal is a fixed `409 window_not_available` with no
    reason; enumerating why would turn the route into a free/busy oracle over a private calendar.
11. **Run the availability suites with `TZ=UTC`**, and the integration file with Docker up — checking
    the test count, not the exit code.

---

## 10. Where the shipped code and SKILL.md diverge

Documented as-built; SKILL.md is not wrong so much as forward-looking in places.

| Subject                | SKILL.md says                                                                             | The shipped code does                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile → slots        | `freeBusy.get` on profile view, union across accounts, slot picker, short-TTL Redis cache | No vendor call at all (`vendorBusyProvider` returns `[]`), no union, no Redis cache, **no slot picker** — the client-facing surface is `earliest_available_at` on the search/card path                                          |
| Forward window         | Constraint 6: "carry the 60-day convention"                                               | 14-day advertise horizon (`RESOLVER_HORIZON_DAYS`), 365-day booking horizon (`MAX_BOOKING_HORIZON_DAYS`). No 60-day value exists                                                                                                |
| `calendar_connections` | "still Cronofy-shaped: unique on `expertProfileId`"                                       | BAL-467 landed: partial unique on `(expert_profile_id, provider)` + nullable `end_user_account_id`. The Cronofy token columns and the `connected \| sync_pending \| auth_error` status vocabulary **are** still there (BAL-396) |
| Availability rules     | "BAL-195 weekly schedule … applied by Balo's slot calculator"                             | Accurate — plus BAL-235 date overrides and BAL-234 buffers/notice, which SKILL.md does not enumerate                                                                                                                            |
| The vendor to wire     | Apiroc, via BAL-396                                                                       | ⚠ The port's own docblocks (and `jobs/availability-cache.ts`) still say **"until BAL-194/195 wires Cronofy"** — pre-ADR-1021 wording. The seam is right; the ticket and vendor named in the comments are stale                  |
