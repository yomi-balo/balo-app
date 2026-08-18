# Availability & free/busy — how Balo computes a bookable slot

This file is the **how** behind SKILL.md's Constraints 3–6 ("There is no delta key", "Free/busy only
for availability", "Slot rules are ours", "Forward window"). SKILL.md tells you what the vendor does
and why Balo reads it the way it does; this file tells you which shipped module does what, in what
order, with what signature, and which invariant fails the build when you get it wrong. Read it before
touching anything under `apps/api/src/services/availability/`, the availability BullMQ job, the
booking gate on `POST /meetings`, or the weekly-rule / time-off tables. Cross-references to SKILL.md
are by section name — the provider-parity table and the hypothesis ledger are not reproduced here,
though the parity rows that specifically bite a free/busy adapter are expanded in
[§3](#3-vendor-busyts--the-one-port). Connect/reconnect flow, credential-status lifecycle and the
proactive health probe are `connect-and-credentials.md`'s scope, not this file's — they are named
here only where they trigger an availability rebuild or a cache clear.

Evidence tags carry SKILL.md's meaning: **[live]** observed against the real API in the BAL-393
spike, **[stat]** read out of the SDK bundle, **[docs]** vendor documentation only. Untagged prose is
a Balo design rule. Ticket numbers mark as-built versus not-yet-built; nothing below describes code
that does not exist without saying so.

---

## 1. What is built today, and what is not

**BAL-396 wired the vendor edge.** Every piece of the availability engine — the rule layer, the
cache, the booking gate, and now the free/busy read itself — is shipped and live. What remains
unbuilt is the CLIENT-FACING slot surface (a per-view vendor call and a slot grid), not the vendor
integration.

| Piece                                             | Ticket            | State                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly rules table + repository                   | BAL-195 / BAL-234 | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Date overrides (time off) table + repository      | BAL-235           | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Pure resolver (`resolve`)                         | BAL-243           | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Booking gate (`isWindowBookable`)                 | BAL-129           | **Shipped, live** on `POST /meetings`                                                                                                                                                                                                                                                   |
| Shared row projections + consultation load pad    | BAL-129           | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Per-(expert, provider) connections, union reader  | BAL-467           | **Shipped, live** — `listBusyReadTargets` / `listConnectionsByExpertProfileId` now have a real caller                                                                                                                                                                                   |
| Apiroc SDK adapter boundary (`callApiroc` etc.)   | BAL-467           | **Shipped, live** — called from `vendor-busy.ts`, `apiroc-connection.ts`, `credential-status.ts`, `calendar-health-probe.ts`, `routes/calendar/auth.ts` (its own top-of-file docblock in `lib/apiroc/index.ts` still says "Inert in this PR — no caller ships"; that is stale, see §10) |
| Vendor free/busy **port**, real `freeBusy.get`    | BAL-396           | **Shipped, live** — fans out across an expert's connections, fails closed on an unreadable one                                                                                                                                                                                          |
| Calendar health probe (proactive breakage signal) | BAL-396           | **Shipped, live** — new rebuild/clear trigger, detailed in §6 and fully in `connect-and-credentials.md`                                                                                                                                                                                 |
| `availability_cache` + BullMQ rebuild job         | BAL-243           | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Cache rebuild on every meeting mutation           | BAL-428           | **Shipped, live**                                                                                                                                                                                                                                                                       |
| Sync-capability matrix + delta-sync guard         | BAL-447           | **Shipped, inert by design** (a ruling, not machinery) — unchanged by BAL-396                                                                                                                                                                                                           |
| Retry classification (`classifyRetry`)            | BAL-467           | **Shipped, but NOT consulted** by the free/busy path — see §3                                                                                                                                                                                                                           |
| Cronofy calendar-change webhook receiver          | pre-ADR-1021      | **DELETED** by BAL-396 (`routes/calendar/webhook.ts` no longer exists)                                                                                                                                                                                                                  |
| Apiroc/Svix calendar-change webhook receiver      | BAL-468           | **NOT BUILT** — no push trigger exists today; staleness is bounded by two 15-minute sweeps only (§6)                                                                                                                                                                                    |
| Per-slot picker / slot-grid surface               | —                 | **NOT BUILT** — see the divergence note in §2 and §10                                                                                                                                                                                                                                   |

> ⚠ **SKILL.md's Architecture Summary is closer to the tree than it used to be, but is still not
> it.** Its "Client views expert profile → `freeBusy.get` → union busy intervals → slot calculator →
> Redis cache" line is now half-true: `freeBusy.get` IS called, and it IS unioned across every one of
> an expert's live connections (§5). What is still missing is the "on profile view" part and the
> Redis slot cache: the vendor read happens only from the BullMQ rebuild job (ADVERTISE) and from
> `POST /meetings` (ACCEPT) — never synchronously from a client's profile-page request — and the only
> cache is one Postgres row per expert holding a single `earliest_available_at`. There is still no
> slot grid.

---

## 2. The pipeline, as built

There are **two reads of the same data, answering two different questions**, and the whole design of
this directory is about stopping them from disagreeing:

- **ADVERTISE** — `resolveAndCacheAvailability` → "when is this expert next free?" Writes
  `availability_cache.earliest_available_at`. Bounded by a **14-day display horizon**.
- **ACCEPT** — `isWindowAvailableForExpert` → "may THIS exact window be booked?" Writes nothing.
  Bounded by the **365-day booking horizon** enforced upstream by `validateBookingWindow`.

```
WRITE TRIGGERS (anything that can move an expert's calendar, or Balo's read of it)
  · calendar connect / reconnect     routes/calendar/auth.ts          (OAuth callback -> persistApirocConnection
    OAuth callback                                                     + provisionConnection -> enqueue)
  · calendar disconnect              routes/calendar/api.ts           (per-provider or whole-account -> enqueue)
  · conflict-check toggle            routes/calendar/api.ts           (changes what listBusyReadTargets returns -> enqueue)
  · schedule editor save/clear       routes/experts/schedule.ts       (3 call sites)
  · time-off create/delete           routes/experts/availability-overrides.ts (2 call sites)
  · book / reschedule / cancel /     services/meetings/meeting-availability.ts (BAL-428)
    soft-delete a meeting
  · calendar health probe            jobs/calendar-health-probe.ts    (every 15 min - heals a connection -> enqueue;
    (heal or break)                                                    detects reconnect_required -> clearAvailabilityCache
                                                                        via services/calendar/credential-status.ts)
  · staleness cron every 15 min      jobs/availability-cache.ts       (credential_checked_at older than 15 min -
                                                                        see warning below)
        │
        ▼
  enqueueAvailabilityCacheRebuild(expertProfileId, log)
        │  jobId: availability-{expertProfileId}   ← coalesces every trigger into ONE pending job
        ▼
  BullMQ queue 'rebuild-availability-cache'  (worker concurrency 5)
        │
        ▼
  resolveAndCacheAvailability(expertProfileId)                  [ADVERTISE — impure adapter]
        ├── expertsRepository.findResolverSettings              tz + buffers + minimum notice
        ├── availabilityRulesRepository.listByExpertProfileId   weekly rules (BAL-195)
        ├── consultationsRepository.listConfirmedInRange        [now−1d, horizonEnd+1d]
        ├── availabilityOverridesRepository.listUpcoming        time off (BAL-235)
        └── vendorBusyProvider.listBusyBlocks(id, from, to)     ← THE ONLY VENDOR SEAM — live freeBusy.get,
              │                                                    fanned out across the expert's connections (§5),
              │                                                    THROWS VendorBusyUnavailableError on an
              │                                                    unreadable connection or a failed read
              ▼
        resolve({ rules, baloConsultations, busyBlocks, overrideBlocks, tz, now,
                  horizonDays, minMinutes, buffers, notice })  [PURE]
              │
              ▼
        calendarRepository.upsertAvailabilityCache(expertProfileId, earliestAvailableAt)
        (⚠ SKIPPED, not run, when the vendor read throws — §5/§9.4 — last-known-good is left in place)

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
              ├── the vendor read runs CONCURRENTLY with the three Balo-owned reads (round-2 fix #10),
              │   not serially ahead of them
              ├── VendorBusyUnavailableError is CAUGHT here and turns into false (fail closed);
              │   any other error still propagates uncaught
              └── isWindowBookable({ … start, end })   [PURE — shares every interval primitive]
           false → 409 { error: 'window_not_available' }   ⚠ fixed literal, never a reason
        5. bookMeeting(...) → writes the consultations projection → enqueues the rebuild
```

⚠ **`jobs/availability-cache.ts`'s own docblock on `startAvailabilityCacheWorker` still reads "BAL-243:
this passes no `busyBlocks`, so the service reads vendor free/busy from the SHARED port
(`services/availability/vendor-busy.ts`), which answers `[]` until BAL-194/195 wires Cronofy."** That
is stale twice over: the port no longer answers `[]` (it makes a real, fanned-out `freeBusy.get`
call), and the vendor it was ever going to wire is Apiroc, not Cronofy — BAL-396, this very ticket,
did the wiring. See §10.

### Module table

| Module (`apps/api/src/services/availability/`) | Purity                           | Exported surface                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                     | types                            | `ResolverRule`, `ResolverConsultation`, `BusyBlock`, `ResolverInput`, `ResolverResult`, `WindowBookableInput`                                                       |
| `resolver.ts`                                  | PURE                             | `resolve(input: ResolverInput): ResolverResult` · `isWindowBookable(input: WindowBookableInput): boolean`                                                           |
| `resolver-inputs.ts`                           | PURE                             | `CONSULTATION_LOAD_PAD_MS` · `toResolverRules` · `toResolverConsultations` · `expandOverrideBlocks(overrides, timezone)`                                            |
| `vendor-busy.ts`                               | port (impure — real network I/O) | `interface VendorBusyProvider` · `const vendorBusyProvider` · `class VendorBusyUnavailableError`                                                                    |
| `resolve-and-cache.ts`                         | impure                           | `resolveAndCacheAvailability(expertProfileId, options?): Promise<ResolveAndCacheResult>` (`{ status: 'completed' \| 'skipped'; skipReason?; earliestAvailableAt }`) |
| `window-availability.ts`                       | impure                           | `isWindowAvailableForExpert(expertProfileId, start, end, now): Promise<boolean>`                                                                                    |

The pure/impure split is load-bearing: `resolve` and `isWindowBookable` read **no DB, no env, no
clock, and never log** — `now` is always injected. That is why every rule below can be tested as a
table of literals (§8). `vendor-busy.ts` is the one module in this directory that is impure by
necessity (it is a live vendor client), not by adapter convenience.

---

## 3. `vendor-busy.ts` — the one port

```typescript
// apps/api/src/services/availability/vendor-busy.ts
export interface VendorBusyProvider {
  listBusyBlocks(expertProfileId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

/**
 * Thrown when the answer cannot be trusted — an unreadable connection, or a vendor read that
 * failed. Callers MUST NOT treat this as "no busy blocks".
 */
export class VendorBusyUnavailableError extends Error {
  /* … */
}

/** THE LIVE IMPLEMENTATION — BAL-396 §9. */
export const vendorBusyProvider: VendorBusyProvider = {
  async listBusyBlocks(expertProfileId, from, to): Promise<BusyBlock[]> {
    const targets = await calendarRepository.listBusyReadTargets(expertProfileId);
    if (targets.length === 0) return []; // no connection at all — see below
    const considered = targets.filter((t) => !t.provisioned || t.calendarIds.length > 0);
    const unreadable = considered.filter(isUnreadable);
    if (unreadable.length > 0) throw new VendorBusyUnavailableError(expertProfileId, '/* … */');
    const results = await Promise.allSettled(
      considered.map((t) => fetchBusyForTarget(t, from, to))
    );
    if (results.some((r) => r.status === 'rejected')) {
      throw new VendorBusyUnavailableError(expertProfileId, 'one or more vendor reads failed');
    }
    return results.flatMap((r) => (r as PromiseFulfilledResult<BusyBlock[]>).value);
  },
};
```

(Reduced for readability — the real file is ~270 lines, almost all of it docblock explaining exactly
the decisions faithfully reproduced below. Read the file itself before touching it.)

**Why it exists, in one sentence:** vendor free/busy was the only resolver input that is a _fetch_
rather than a _row projection_, so it escaped the `resolver-inputs.ts` extraction and each of the two
reads used to default it to its own inline `[]` — meaning a vendor wired at the ADVERTISE call site
alone would have left the ACCEPT gate double-booking over an expert's real external commitments
**with no type, no test and no helper failing**. A shared literal would only be a grep target; a
shared port is a compile dependency — and BAL-396 is the ticket that proved the point by wiring a
real vendor behind it once, for both readers at once.

### The rules

1. **Every availability path reaches a calendar vendor through `vendorBusyProvider.listBusyBlocks`
   and nowhere else.** Not through the job, not through a route, not through a second provider object
   keyed on the caller.
2. **It reads a WINDOW, never a delta.** `[from, to)` is whatever the caller needs answered — the
   whole forward horizon for advertise, one padded booking window for accept. The live implementation
   does not assume either shape and carries no cursor (§7).
3. **The only sanctioned divergence is `ResolveAndCacheOptions.busyBlocks`**, a seed/test-only
   override used by `services/seed/seed-service.ts`. When supplied the port is not consulted at all,
   so in a seeded environment the advertised answer accounts for synthetic blocks and the booking
   gate does not. That is why "advertise and accept agree" is a claim about **production**.
4. **Every call returns a fresh array** — both call sites spread it into
   `[...busyBlocks, ...overrideBlocks]`, and a returned singleton would be exactly what a later
   caller mutates in place. Pinned by `vendor-busy.test.ts`.

### No connection vs. an unreadable one — the distinction is load-bearing

- **No connection at all** (`listBusyReadTargets` returns `[]`) → `listBusyBlocks` returns `[]`
  **before any Apiroc client is even constructed** (§9.3). This is deliberate: an unset
  `APIROC_API_KEY` must not be able to throw `ApirocConfigError` into the booking path for an expert
  who never connected a calendar at all — every expert, on the merge commit, since Apiroc rows can
  only be created by this ticket's OAuth callback. **The merge commit is therefore a BEHAVIOURAL
  NO-OP** for every pre-existing expert: wiring turns on per expert, at the moment they connect.
- **An unreadable connection** — `credentialStatus !== 'ACTIVE'` (`SYNC_PENDING` / `EXPIRED` /
  `REVOKED`), or `ACTIVE` with zero sub-calendar rows at all (never provisioned) — **throws
  `VendorBusyUnavailableError`, never returns `[]`.** Returning `[]` here would read as "this expert
  has no external commitments" — fail OPEN, and double-book them in front of a paying client.
- **A provisioned, `ACTIVE` connection with every sub-calendar `conflict_check = false`** is
  DIFFERENT from both of the above, and is filtered out BEFORE the unreadable check runs (round-2 fix
  #5): it is the expert's explicit choice to exclude every calendar on that connection from
  conflict-checking, so it contributes nothing to the union — same as having no connection at all —
  and does NOT make the whole read untrustworthy. An UNPROVISIONED connection (`calendarIds` also `[]`
  structurally) is never excluded by this filter, because Balo has never listed its calendars and
  cannot know what conflict-checked calendars might be hidden there; it is still checked by the
  unreadable predicate below.
- With two or more connections, **one unreadable connection makes the WHOLE read untrustworthy**,
  even if the expert's other connection is perfectly healthy — see §5.

### Parsing — what the shipped code enforces, and why

`toBusyBlocks` parses one vendor `FreeBusySlot` at a time. `BusySlot.start`/`end` and
`EventDateTime.dateTime` are all OPTIONAL BY TYPE in the SDK, so a real commitment can arrive in an
unparseable shape — not merely a corrupted one.

- **Offset requirement.** The vendor's own field doc reads _"ISO 8601 format (e.g.
  2023-03-15T10:00:00)"_ — i.e. NO OFFSET is guaranteed by the shape, with the zone meant to be
  carried in the sibling `timeZone` field. Per the ES spec, a date-time string with no offset
  designator parses as SERVER-LOCAL, not UTC — parsing such a string on a non-UTC host silently
  returns the wrong instant. Every observed response so far has carried a trailing `Z` (`:00Z` /
  `:00.000Z`), but the code does not lean on that as a contract:
  - A `dateTime` matching `HAS_OFFSET_DESIGNATOR` (`Z` or `±HH:MM`, trailing) is parsed directly.
  - A NAIVE `dateTime` (no offset) is resolved through its sibling `timeZone` via `fromZonedTime` —
    the same DST-correct primitive `resolver.ts` already uses for weekly rules.
  - A naive `dateTime` with **no `timeZone` to resolve it against** cannot be trusted and is treated
    as unparseable — `parseInstant` returns `null`, never a guessed instant.
- **What happens to an unparseable slot: it is never silently dropped.** `toBusyBlocks` counts a
  `droppedCount` for every slot whose `start`/`end` failed to parse, or whose parsed `end` is not
  strictly after `start`. `fetchBusyForTarget` treats ANY `droppedCount > 0` as an untrustworthy read
  for that account and throws — which `listBusyBlocks`'s `Promise.allSettled` handling turns into
  `VendorBusyUnavailableError` for the whole call, same as any other rejected account (§5). Silently
  skipping an unparseable slot would make `isWindowBookable` see the window as free and double-book
  the expert — exactly the failure §9.4 exists to prevent. Partial data is not an answer.

### What the port normalises (the parity items that bite free/busy)

Expanding only the rows of SKILL.md's **Provider-parity table** that this adapter touches. All
**[live]** from BAL-393.

| Divergence                 | Google                | Microsoft                  | What the shipped port does                                                                                                                                                 |
| -------------------------- | --------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busySlots` timezone label | `UTC`                 | `Etc/UTC`                  | Never string-compares a tz name. `BusyBlock` is two **UTC `Date` instants**; converted at the boundary via `parseInstant`, the label dropped.                              |
| `dateTime` precision       | second precision, `Z` | millisecond precision, `Z` | Parsed with the platform `Date` constructor when an offset is present — never string-compared or deduped on the raw string.                                                |
| Response envelope          | bare array            | bare array                 | `freeBusy.get` returns `FreeBusySlot[]` directly — the port reads it as such, not through a `{ data }` envelope.                                                           |
| Calendar `timeZone` field  | populated             | **absent**                 | Never sourced for the expert's own timezone; that stays `expert_profiles.timezone` (§4). Used only as `dateTime`'s sibling for a naive value on a busy slot, when present. |
| Calendar id format         | email address         | 152-char opaque Graph id   | `calendarIds` come from stored `calendar_sub_calendars.calendar_id` rows, written verbatim from `calendars.list`; the port never builds a path by hand.                    |

Two further constraints, both from SKILL.md, both honoured by the shipped code:

- **Privacy (Constraint 4):** availability is sourced from `freeBusy.get` — busy slots, no titles.
  `toBusyBlocks` reads only `busySlots[].start`/`end`; it never reads an event title or body. A full
  event read on this path is banned and the ban is enforced (§7, Scan C / Scan E).
- **Errors:** every vendor call goes through `callApiroc('freeBusy.get', () => …)` from
  `apps/api/src/lib/apiroc/`, which normalises the SDK's mangled error into an `ApirocError` with a
  `kind` and the `x-request-id` attached. `fetchBusyForTarget` wraps exactly ONE `callApiroc` call per
  account — the fan-out across an expert's connections is `Promise.allSettled` over SEPARATE
  `callApiroc` invocations, honouring `callApiroc`'s one-fallible-call contract, never one call
  wrapped around the whole fan-out.
  ⚠ **`classifyRetry(err)` — the shipped retry-decision table (`lib/apiroc/retry.ts`:
  `validation`/`unauthorized`/`forbidden`/`not_found`/`unknown` never retry; `rate_limited` honours
  `Retry-After`, default 5000 ms; `server_error` and `network` retry) — has NO production caller on
  this path.** `fetchBusyForTarget` makes exactly one `callApiroc('freeBusy.get', …)` attempt; any
  rejection — transient network blip or a permanent 4xx alike — becomes part of the
  `Promise.allSettled` result and, on the very first failure, `VendorBusyUnavailableError` (§5). The
  BullMQ job that runs `resolveAndCacheAvailability` still retries the WHOLE job up to 3 times with
  exponential backoff (§6), but that retry is unconditional on error kind, not `classifyRetry`-aware —
  a `validation` failure (`classifyRetry` says never retry) gets exactly the same 3 attempts as a
  `network` blip (`classifyRetry` says retry). See §10 for this as a named divergence.

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
return {
  earliestAvailableAt: longEnough[0] ? laterOf(longEnough[0].startAt, now) : null,
};
```

### Subtraction semantics

- **One busy set, no precedence.** Confirmed consultations, vendor busy blocks and expanded date
  overrides are concatenated, padded, and sorted once. Interval set-difference is order-independent
  (subtracting A then B equals subtracting the union of A and B), so there is no "override beats
  consultation" rule to get wrong — and no place to add one.
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

`expandRuleOnDate` expands one rule, on one local date, with two independent UTC conversions: it
compares `endTime < startTime` as a string (deliberately) to detect a midnight-crossing rule, then
runs `fromZonedTime` separately on the start local-date-time and the end local-date-time (which may
be the next calendar day) against the expert's own timezone.

- **Per-date expansion, not a fixed offset.** `expandRulesInRange` iterates _local_ dates, so one
  `dayOfWeek: 0` rule resolves to UTC+11 on the Sunday before a Sydney DST transition and UTC+10 on
  the Sunday after. Both directions are pinned by tests.
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
- **Date overrides are calendar dates, expanded in the expert's tz, end-INCLUSIVE:** a single-day
  override with `startDate === endDate` (e.g. `2026-09-07`) expands to one interval running from
  midnight of that local date to midnight of the NEXT local date, both converted to UTC via the
  expert's timezone — e.g. `Australia/Sydney` on `2026-09-07` produces
  `[2026-09-06T14:00Z, 2026-09-07T14:00Z)`.

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
17:30 against a 09:00–17:00 rule is refused, not trimmed). `isWindowAvailableForExpert` adds two
more: a missing expert profile or timezone returns `false` and logs a warning without even reading
rules or consultations; and — new in BAL-396 — an untrustworthy vendor busy read
(`VendorBusyUnavailableError`) also returns `false` (§5).

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
partial on `deleted_at IS NULL`, and the reader the union needs is now LIVE:

```typescript
// packages/db/src/repositories/calendar.ts — the free/busy read's connection list
calendarRepository.listBusyReadTargets(expertProfileId): Promise<BusyReadTarget[]>;
// One round trip; returns EVERY live connection (any credentialStatus — see §3), each with its
// conflict-checked calendar ids and a `provisioned` flag. Deliberately NOT
// `findConnectionByExpertProfileId` — that returns ONE row (oldest live) and would silently
// ignore the expert's second calendar, double-booking them.
```

**What is actually built, now:** `vendorBusyProvider.listBusyBlocks` calls `listBusyReadTargets`,
filters out connections that contribute nothing (provisioned + explicitly opted every calendar out —
§3), rejects the whole read if any REMAINING connection is unreadable, and otherwise fans out one
`freeBusy.get` per remaining connection via `Promise.allSettled`, unioning every returned `BusyBlock`
into one array. This is genuinely a fan-out across providers, not a single-account stub.

**The failure posture is now DECIDED, not open.** The shipped policy is **(a) refuse the whole
answer**: if ANY connection's read is unreadable or its `freeBusy.get` call rejects (including a
`droppedCount > 0` unparseable slot, §3), `listBusyBlocks` throws `VendorBusyUnavailableError` and
discards every OTHER connection's successfully-fetched blocks too — a partially-fulfilled
`Promise.allSettled` is not treated as a partial answer. Options (b) "proceed on the providers that
answered" and (c) "serve the last good cache" were both considered (see the historical framing this
section used to carry) and NOT chosen; (c) is effectively what happens one level up, in each caller:

| Path                                                            | On `VendorBusyUnavailableError`                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADVERTISE (`resolveAndCacheAvailability`, in the BullMQ worker) | Returns `{ status: 'skipped', skipReason: 'vendor_busy_unavailable' }` and does **not** write `availability_cache` — last-known-good is left in place, stale but not cleared. The job itself does NOT fail (no BullMQ retry) for this specific outcome — only for an unexpected non-vendor error, which still propagates and triggers the job's normal `attempts: 3` retry. |
| ACCEPT (`isWindowAvailableForExpert`, in `POST /meetings`)      | Caught, logged at `warn`, and turned into `false` — the booking gate answers a clean `409 window_not_available`, not a 500. A non-`VendorBusyUnavailableError` rejection (e.g. a `@balo/db` outage) still propagates uncaught to Fastify's error handler as a 500, exactly as any other DB read failure would.                                                              |

So both the advertise and accept paths fail closed on an untrustworthy vendor read, and both do so
cleanly (a mapped skip reason / a mapped 409), which closes the open question the pre-BAL-396 version
of this section posed. What is still true: an unreadable SECOND connection makes the whole expert
unavailable even though their FIRST connection might answer fine — that is the direct, intended
consequence of "refuse the whole answer," not an oversight.

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
    earliestAvailableAt: timestamp('earliest_available_at', {
      withTimezone: true,
    }),
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

| Writer                                                                           | Method                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveAndCacheAvailability` (the ADVERTISE upsert)                             | `calendarRepository.upsertAvailabilityCache(id, earliestAvailableAt)` — `onConflictDoUpdate` on the PK                                                                                                                                                          |
| `services/calendar/credential-status.ts`'s `flipToReconnectRequired`             | `calendarRepository.clearAvailabilityCache(id)` — called when the health probe confirms a connection now needs reconnecting (`EXPIRED`/`REVOKED`)                                                                                                               |
| `services/calendar/apiroc-connection.ts`'s `provisionConnection`, two call sites | `calendarRepository.clearAvailabilityCache(id)` — a `calendars.list` failure, or a successful list with zero writable calendars, both persist `SYNC_PENDING` and clear the cache so a now-unreadable connection is not advertised on stale last-known-good data |

`routes/calendar/webhook.ts` — the Cronofy-era route that used to own the `profile_disconnected`
clear — **no longer exists** (deleted by BAL-396). `POST /api/calendar/disconnect` in
`routes/calendar/api.ts` does not itself clear the cache; it calls `enqueueAvailabilityCacheRebuild`,
which RECOMPUTES from whatever connections remain (nothing, if the expert had only one) rather than
blanking the row directly — correct once an expert can hold two connections and disconnect only one.

### The job

```typescript
// apps/api/src/jobs/availability-cache.ts
export const AVAILABILITY_CACHE_QUEUE = 'rebuild-availability-cache';
export const STALENESS_CHECK_QUEUE = 'staleness-check';

await queue.add(
  'rebuild-availability-cache',
  { expertProfileId },
  {
    jobId: 'availability-' + expertProfileId, // THE DEDUP KEY
    removeOnComplete: true,
    removeOnFail: true, // a retained failed job would wedge this fixed jobId forever
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  }
);
```

- **`jobId` is fixed per expert**, so a burst of triggers (a reconnect + a schedule save + a booking)
  collapses into one pending rebuild.
- **`removeOnFail: true` is load-bearing, not tidiness.** With a fixed `jobId`, a _retained_ failed
  job blocks every later enqueue for that expert — permanently wedging their availability. Dropping
  it lets the next trigger self-heal; `worker.on('failed')` is the observability.
- **Enqueue never throws.** A Redis hiccup must not fail the caller's mutation, so
  `enqueueAvailabilityCacheRebuild` swallows and logs. ⚠ That means a booking can commit while its
  rebuild is silently lost — which is exactly what the staleness sweep and the next trigger repair.
- Worker `concurrency: 5`; emits `CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT` with
  `distinct_id: expertProfileId` **only when `result.status === 'completed'`** (round-2 fix #11) — a
  SKIPPED rebuild (settings missing, or an untrustworthy vendor read, §5) logs a distinguishable
  `job.log` line instead and fires no analytics event, so a skip can never be misread as a genuine
  rebuild with `earliestAvailableAt: null` (which is also the legitimate answer for an expert who
  really has no open slot).

### How staleness is bounded

There is still **no push trigger**. BAL-468 (Apiroc/Svix webhook) is not built; the Cronofy bare-
trigger receiver BAL-396 deleted is not replaced yet. Staleness today is bounded by mutation triggers
plus TWO independent 15-minute sweeps:

1. **Mutation** — every meeting write rebuilds via `services/meetings/meeting-availability.ts`
   (BAL-428). `expertProfileId === null` (an `admin` meeting) rebuilds nobody, by design. Connect,
   disconnect and conflict-check-toggle also enqueue directly (§2's WRITE TRIGGERS table).
2. **The staleness cron** (`registerStalenessCheckCron`, `jobs/availability-cache.ts`) runs
   `*/15 * * * *`; the worker takes `findStaleConnections(now − 15 min)` — live, `ACTIVE`
   connections whose `credential_checked_at` is older than the threshold — and enqueues a rebuild for
   each. ⚠⚠ **This key changed on this branch.** Before BAL-396's fix round it read
   `last_synced_at`, whose only writer was the Cronofy-era webhook route BAL-396 deleted — so with no
   writer left, that query was a PERMANENT no-op (every tick found nothing, and reported nothing
   wrong). It now reads `credential_checked_at`, which the health probe and
   `upsertApirocConnection` both stamp, restoring a genuine periodic rebuild.
3. **The calendar health probe** (`registerCalendarHealthProbeCron`,
   `jobs/calendar-health-probe.ts`) runs on its OWN 15-minute cron, against a DIFFERENT candidate
   query (`listConnectionsDueForHealthCheck`, keyed on the same `credential_checked_at` column but
   including non-`ACTIVE` rows so it can heal them too) and makes an actual cheap Apiroc data call
   (`calendars.list` with `pageSize: 1`) per candidate. It is the platform's only PROACTIVE breakage
   signal — it can flip a connection to `EXPIRED`/`REVOKED` (clearing the cache) or heal a
   `SYNC_PENDING`/broken one back to `ACTIVE` (enqueuing a rebuild) before any client ever hits it.
   `PROBE_INTERVAL_MS` (1 hour — its own re-probe cadence) is asserted at MODULE LOAD to stay
   strictly greater than the staleness cron's 15-minute threshold, specifically to stop a future
   tuning change from silently re-arming the same permanent-no-op failure class the `last_synced_at`
   bug was. Full mechanics (the mass-failure circuit breaker, the re-provision heal path, the
   notify-once discipline) are `connect-and-credentials.md`'s scope, not this file's — this section
   only tracks it as an availability-rebuild/cache-clear trigger.

So the bound is **~15 minutes plus one job**, now via two independent sweeps rather than one, and
only for experts with a live calendar connection — an expert with no connection is refreshed only by
their own edits and by bookings. There is still **no TTL** on the row and no read-through refresh: a
stale row is served as-is until something enqueues.

---

## 7. ⚠⚠ The delta-sync ban, in enforcement terms

SKILL.md Constraint 3 states the ruling. This section is what happens to you in CI.

**The ruling** (BAL-447 / ADR-1021 amendment 2026-08-15, amended again 18 Aug 2026 for BAL-396),
quoted from the guard:

> Balo performs no calendar delta sync. For every provider, a calendar-change webhook is a bare
> trigger that enqueues a whole-window availability rebuild; availability is always recomputed from a
> windowed free/busy read via `vendorBusyProvider.listBusyBlocks`. `syncToken` / `nextSyncToken` is
> never read and never stored. There is no provider-conditional sync path, and no code outside the
> vendor boundary reads calendar EVENT CONTENT on the availability path.

### What `services/calendar/sync-capability.ts` encodes

It is **inert by design** — a shipped ruling, not machinery. Do not import it; read it. Unchanged in
shape by BAL-396:

```typescript
export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const; // apple/icloud deliberately absent
export const SYNC_STRATEGIES = ['full_window_reread'] as const; // SINGLE-MEMBER ON PURPOSE

export const SYNC_CAPABILITY_MATRIX = {
  google: {
    supportsSyncToken: true, // an OBSERVED VENDOR FACT
    deltaMechanism: 'events_list_sync_token',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread', // BALO'S RULING
    evidence: 'BAL-393 FINDINGS.md §P3 — nextSyncToken on the FINAL page only',
  },
  microsoft: {
    supportsSyncToken: false,
    deltaMechanism: 'none',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread',
    evidence: 'BAL-393 FINDINGS.md §M2 — never returned, any page, exhausted at pageSize=1',
  },
} as const;

/** Reads the matrix — and deliberately does NOT read supportsSyncToken. */
export function resolveSyncStrategy(provider) {
  return SYNC_CAPABILITY_MATRIX[provider].baloSyncStrategy;
}
```

The two columns are **decoupled on purpose**: capability is an observation, strategy is a ruling, and
strategy is not a function of capability. `SYNC_STRATEGIES` is single-member so that introducing
provider conditionality is an edit to one pinned line. Adding a provider without a matrix row is a
**compile error** (`satisfies`).

`SYNC_PATH_FILES` (the same module) survives only as an asserted SUBSET sanity check listing
`jobs/availability-cache.ts`, `services/availability/vendor-busy.ts`,
`services/availability/resolve-and-cache.ts`, `services/availability/window-availability.ts` — it is
**not** any scan's subject list (see below).

### What `invariants/sync-token-parity.test.ts` fails the build for

Three layers, **877 lines**, every Layer-3 scan deriving its subjects from a **directory walk over
`apps/api/src`, `.ts` AND `.tsx`** (never a pinned file list — a pinned list passes vacuously for
exactly the future files that matter, and that opt-out was empirically reproduced in review; the
`.tsx` widening is itself a BAL-396 fix-round-2 finding — see below).

| Layer / Scan   | Subject                                                                                                                          | Fails when                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — DATA**   | the matrix                                                                                                                       | the Google/Microsoft divergence stops being recorded, or a row loses its `BAL-393` evidence (anchored by direction _and_ by §M2/§P3 refs)                                                                                                                                                                                                                                                                                          |
| **2 — RULING** | `resolveSyncStrategy`, `SYNC_STRATEGIES`                                                                                         | a second strategy appears, or the strategy stops being identical for every provider. ⚠ Flipping a boolean cannot make this pass or fail — only rewriting the resolver can                                                                                                                                                                                                                                                          |
| **3 / Scan A** | **all** of `apps/api/src` (exempt: the matrix file, `invariants/`)                                                               | any non-comment line anywhere contains `syncToken` / `SyncToken` / `sync_token`                                                                                                                                                                                                                                                                                                                                                    |
| **3 / Scan B** | **all** of `apps/api/src` (exempt: `lib/apiroc/` — the vendor boundary; `routes/calendar/` — the connect surface)                | a file names `google`/`microsoft`/`apple`/`icloud` (after stripping two known-safe idioms, `googleapis`/`-apple-system`, from CSS font stacks), or contains `provider ===` / `switch (provider`                                                                                                                                                                                                                                    |
| **3 / Scan C** | `services/availability/vendor-busy.ts`, and both its consumers                                                                   | the port stops containing a genuine `freeBusy.get` call, contains any event-content marker itself, or either consumer stops calling `vendorBusyProvider.listBusyBlocks` / starts calling `freeBusy`/`getApirocClient` directly. **Retired** the old webhook-route-scoped check — its subject, `routes/calendar/webhook.ts`, no longer exists                                                                                       |
| **3 / Scan D** | `routes/calendar/types.ts`, `routes/calendar/auth.ts`                                                                            | the hand-written provider unions drift from `CALENDAR_PROVIDERS`                                                                                                                                                                                                                                                                                                                                                                   |
| **3 / Scan E** | **all** of `apps/api/src` (exempt: `services/consultation-events/` — the one directory sanctioned for a full event-content read) | E1: `updatedAfter` or `expandRecurrences` appears ANYWHERE, no exemption at all. E2: `events.list` appears outside `services/consultation-events/`. E3: inside that one exemption, an `events.list` call is missing `metadataFilters` or `nextPageToken` (must be BOTH tag-filtered and paginated to exhaustion). E6: the Scan B and Scan E exemption sets are disjoint, and every file is covered by at least one of the two bans |

Markers are matched against **raw source, line-classified** — a marker inside a string literal on a
code line trips the scan (a comment-_stripping_ version was fail-open: it truncated a raw `fetch(...)`
call at the `//` inside its URL and passed). Prose that merely names the construct does not trip it.

⚠ **The `.tsx` widening (BAL-396 fix round 2, Finding 3) closed a real hole.** The walk used to filter
on files ending in `.ts` only, which silently skipped every `.tsx` file — all 51 of them under
`notifications/channels/templates/`, including this ticket's own new
`calendar-reconnect-required.tsx`. Widening the walk surfaced a genuine false positive of its own:
`templates/shared.tsx` and `templates/review-email-shared.tsx` both carry a CSS font stack containing
`fonts.googleapis.com` and `-apple-system` — ordinary CSS substrings of `google`/`apple` with zero
connection to a calendar provider. Rather than exempt the two files outright (which would also blind
Scan B to a REAL provider literal added to them later), `providerNamesIn` strips exactly those two
idioms before matching, and a positive/negative regression control pins that a genuine `google` /
`apple` literal sitting right next to the idiom still trips the scan.

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
   no sync token: a timestamp-differenced listing read is the same rejected option in different
   clothing — and `calendar_connections.credentialCheckedAt` already exists and is already written on
   health-probe attempts and on connect/reconnect, so the ingredients are on the shelf.
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

| File                                       | Kind                   | What it pins                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver.test.ts`                         | pure unit              | every slot rule as literals: DST both directions, spring-forward gap, cross-midnight, buffers, notice, horizon, overrides                                                                                                                                                                                                                                                                                           |
| `window-bookable.test.ts`                  | pure unit              | the accept predicate: wholly-inside, straddle, adjacency, per-tz interpretation, degenerate inputs fail closed                                                                                                                                                                                                                                                                                                      |
| `resolver-inputs.test.ts`                  | pure unit              | the three row projections, end-inclusive override expansion, the `nextDayIso` throw                                                                                                                                                                                                                                                                                                                                 |
| `vendor-busy.test.ts`                      | unit (mocked SDK/repo) | §9.3 the no-connection rollout seam (`[]`, no client constructed); §9.4 an unreadable connection throws, a provisioned-but-opted-out one does not; the fan-out unions across accounts with one `callApiroc` per account; parity parsing (Google/Microsoft shapes, naive `dateTime` + sibling `timeZone`, no-`timeZone` unparseable); any unparseable/inverted/zero-length slot throws rather than answering partial |
| `resolve-and-cache.test.ts`                | mocked unit            | load ranges, env precedence, the shared port is consulted, the seed override bypasses it, **BAL-396 §9.4**: the advertise path SKIPS the cache write (not fails the job) on `VendorBusyUnavailableError`, and distinguishes `skipReason: 'vendor_busy_unavailable'` from an unclassified `'vendor_read_error'`                                                                                                      |
| `window-availability.test.ts`              | mocked unit            | fail-closed, padded loads, that it reads the **same port object** and writes nothing, that the vendor read runs **concurrently** with the three Balo-owned reads (not serially ahead of them), and that `VendorBusyUnavailableError` — and only that error — is caught and turned into `false`                                                                                                                      |
| `availability-cache.test.ts`               | mocked unit            | queue names, the dedupe `jobId`, `removeOnFail`, enqueue never throws, and that a SKIPPED rebuild does not fire `AVAILABILITY_CACHE_REBUILT` and logs a distinguishable message                                                                                                                                                                                                                                     |
| `booking-availability.integration.test.ts` | integration            | book → the slot disappears → cancel → it returns, against real Postgres                                                                                                                                                                                                                                                                                                                                             |
| `invariants/sync-token-parity.test.ts`     | invariant              | the ban (§7)                                                                                                                                                                                                                                                                                                                                                                                                        |

`calendar-health-probe.test.ts` and `apiroc-connection.test.ts` (`apps/api/src/jobs/` and
`apps/api/src/services/calendar/`) pin the health-probe heal/break cycle and the connect/provision
flow that feed §6's rebuild and clear triggers — their full contract is `connect-and-credentials.md`'s
territory, not reproduced here.

### The patterns

- **Inject the clock; never mock it.** `resolve` / `isWindowBookable` take `now`. Every suite pins a
  literal instant (`2026-06-01T00:00:00.000Z` in the resolver suite, `2026-09-07T00:00:00.000Z` in
  the BAL-129 ones) and asserts literal expected instants — no arithmetic in the expectations.
- **Pin the timezone explicitly**, including in fixtures: the integration test sets
  `expert_profiles.timezone = 'UTC'` even though that is already the default, so the assertions do
  not depend on a column default that is free to change.
- **Derive fixture weekdays from the fixture dates** so an edited date cannot silently stop testing
  the intended day.
- **Never mock `./resolver.js` from an adapter test** — the pure decision logic is what the adapter
  exists to reach; mocking it leaves nothing under test but four call signatures. (Conversely
  `resolve-and-cache.test.ts` _does_ mock it, because its subject is the load/write wiring.)
- **Spy the port, don't mock the module.** Both adapter suites spy on
  `vendorBusyProvider.listBusyBlocks` directly. A module mock would paper over the property under
  test — that both adapters read the _same object_.
- **Pass `horizonDays` and `minMinutes` explicitly** in any test that asserts an instant: both fall
  back to env vars, and an environment that set either would silently change every expectation.
- **⚠ Run vitest with `TZ=UTC`.** Some suites fail only on a non-UTC shell; CI is UTC. `apps/api`'s
  config is `environment: 'node'`, `include: src/**/*.{test,spec}.ts`, and — load-bearing —
  excludes `src/**/*.integration.test.ts`.
- **Integration tests in `apps/api` run from `packages/db/vitest.config.integration.ts`**, whose
  `root` is the repo root and whose `globalSetup`/`setupFiles` are absolute, so one testcontainer
  serves both packages and every write lands in the per-test transaction. ⚠ `pnpm test:integration`
  **passes vacuously without Docker** (prints "No test files found" and exits 0) — check the reported
  test **count**, never the exit code.
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
   provider branch, no event content — and run the sync-token-parity invariant suite with `TZ=UTC`
   before you push.
10. **Keep the messaging opaque.** The booking refusal is a fixed `409 window_not_available` with no
    reason; enumerating why would turn the route into a free/busy oracle over a private calendar.
11. **Run the availability suites with `TZ=UTC`**, and the integration file with Docker up — checking
    the test count, not the exit code.
12. **If you touch `vendor-busy.ts`'s fan-out or failure handling, re-read §5.** The "refuse the
    whole answer on any connection failure" policy is a decision, already made and tested — changing
    it to "proceed on the providers that answered" is a product ruling, not a bug fix, and both
    callers' fail-closed contracts (§9.4 in each) depend on the current shape.

---

## 10. Where the shipped code and SKILL.md diverge

Documented as-built; SKILL.md is not wrong so much as forward-looking in places, and BAL-396 closed
several of the gaps this table used to describe.

| Subject                          | SKILL.md says                                                                             | The shipped code does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile → slots                  | `freeBusy.get` on profile view, union across accounts, slot picker, short-TTL Redis cache | `freeBusy.get` IS called and IS unioned across every one of an expert's live connections — but only from the BullMQ rebuild job (ADVERTISE) and `POST /meetings` (ACCEPT), never synchronously "on profile view". Still no Redis cache, still **no slot picker** — the client-facing surface is `earliest_available_at` on the search/card path                                                                                                                                                                                                           |
| Forward window                   | Constraint 6: "carry the 60-day convention"                                               | 14-day advertise horizon (`RESOLVER_HORIZON_DAYS`), 365-day booking horizon (`MAX_BOOKING_HORIZON_DAYS`). No 60-day value exists                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `calendar_connections`           | "still Cronofy-shaped: unique on `expertProfileId`"                                       | **Fully migrated off Cronofy by this ticket.** Unique on `(expert_profile_id, provider)` (BAL-467); `end_user_account_id` is the only vendor identity and is `NOT NULL` (migration 0069); the Cronofy token columns (`access_token`, `refresh_token`, `token_expires_at`, `channel_id`, `cronofy_sub`) and the `connected \| sync_pending \| auth_error` status vocabulary are ALL DROPPED — replaced by `ACTIVE \| SYNC_PENDING \| EXPIRED \| REVOKED` (migration 0068). The pre-BAL-396 version of this row was itself already stale the day it shipped |
| Availability rules               | "BAL-195 weekly schedule … applied by Balo's slot calculator"                             | Accurate — plus BAL-235 date overrides and BAL-234 buffers/notice, which SKILL.md does not enumerate                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The vendor to wire               | Apiroc, via BAL-396                                                                       | **Done.** `jobs/availability-cache.ts`'s own docblock on `startAvailabilityCacheWorker` still says "answers `[]` until BAL-194/195 wires Cronofy" — stale, pre-ADR-1021 wording, now doubly wrong (the vendor is Apiroc, and BAL-396 already wired it). `vendor-busy.ts`'s own docblock, by contrast, has been fully rewritten and is accurate; `lib/apiroc/index.ts`'s `callApiroc` docblock still says "Inert in this PR — no caller ships", which is also stale — it has five production callers today                                                 |
| Retry on a failed `freeBusy.get` | (not previously addressed)                                                                | `classifyRetry` (`lib/apiroc/retry.ts`) is fully built and table-tested but has **no production caller** on the free/busy path: `fetchBusyForTarget` makes exactly one `callApiroc` attempt and any rejection becomes `VendorBusyUnavailableError` on the first try. The BullMQ job's `attempts: 3` retry is unconditional on error kind, not `classifyRetry`-aware                                                                                                                                                                                       |
| Union across providers           | (not previously addressed — BAL-467's reader was inert)                                   | Live as of this ticket: `vendorBusyProvider.listBusyBlocks` fans out across every live connection via `listBusyReadTargets`, with a documented "refuse the whole answer if any connection is unreadable or fails" policy (§5)                                                                                                                                                                                                                                                                                                                             |
| Calendar-change push trigger     | Cronofy webhook today, Apiroc/Svix (BAL-468) eventually                                   | The Cronofy webhook route is DELETED. The Apiroc/Svix webhook (BAL-468) is not yet built. There is currently **no push trigger at all** — staleness is bounded by two independent 15-minute sweeps (the staleness cron and the calendar health probe) plus direct mutation triggers (§6)                                                                                                                                                                                                                                                                  |

---

## Appendix — notes surfaced during this reconciliation, flagged for escalation

Not fixed here (docs-only pass); flagged for the humans who own these files. Neither blocks this
document from being accurate about current behaviour, since both describe the CURRENT, real
behaviour — the open question is whether that behaviour is what BAL-396 actually intended.

1. **SUSPECTED CODE DEFECT — `classifyRetry` is dead code on the free/busy path.**
   `apps/api/src/lib/apiroc/retry.ts` is fully implemented and unit-tested, and its own docblock says
   "BAL-396/468 map this onto job options" — but nothing in `vendor-busy.ts`, `resolve-and-cache.ts`,
   `window-availability.ts`, or the BullMQ job options in `jobs/availability-cache.ts` reads it. A
   single transient network blip during `freeBusy.get` is treated identically to a permanent
   `validation` failure: one failed attempt, then `VendorBusyUnavailableError`, then (at the job
   level) an unconditional 3-attempt retry of the WHOLE rebuild regardless of whether `classifyRetry`
   would say "never retry" for that error kind. This may be intentional simplicity for this ticket
   (fail closed fast, let the 15-minute sweeps repair it) rather than an oversight, but as shipped,
   the "shipped retry table" is not actually consulted anywhere reachable from this file's code
   paths.
2. **Stale docblocks, not a behavioural bug.** Two pre-ADR-1021 docblocks survive in shipped code,
   both naming Cronofy where the vendor is now Apiroc and already wired: `jobs/availability-cache.ts`'s
   `startAvailabilityCacheWorker` docblock, and `lib/apiroc/index.ts`'s `callApiroc` docblock ("Inert
   in this PR — no caller ships", despite five production callers). Neither changes runtime
   behaviour, but both actively mislead a reader about whether the vendor integration is wired.
