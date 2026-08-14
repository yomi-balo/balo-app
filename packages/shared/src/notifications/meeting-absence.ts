/**
 * BAL-134 (§6) — THE TWO MEETING-ABSENCE NOTIFICATION PAYLOADS.
 *
 * ⚠ DEFINED **ONCE**, HERE. A notification payload declared in two places trips the SonarCloud
 * new-code duplication gate (memory `reference_notification_event_dup_shared_home`) and, worse,
 * lets the two copies drift while both compile. `apps/api/src/notifications/events.ts` imports
 * these; nothing restates them.
 *
 * ⚠ BOTH EVENTS ARE `ServerOnlyNotificationEvent`. They are published EXCLUSIVELY by BAL-420's
 * dispatch tick, which only ever runs in `apps/api` — so neither gets a `publishBodySchema`
 * arm, and adding one would be a `StraySchemaArm` and fail `tsc`. `apps/web` never publishes
 * either.
 *
 * ⚠ BOTH ARE SCHEDULED, SO BOTH PAYLOADS SIT IN A POSTGRES TABLE FOR THE LIFE OF THE PROMISE
 * (ADR-1047 Decision 4). That is why neither carries an email address, a name, a token, or any
 * money figure — ids, labels and ISO instants only. The recipients are resolved at FIRE time by
 * the engine, from `recipientUserIds` for the fan-out and from `OPS_NOTIFICATION_EMAIL` for the
 * ops alert.
 *
 * ⚠ AND EVERY FIELD MUST SURVIVE A REBUILD. Both events carry a registered fire-time `recheck`
 * that re-reads live state and SPREADS the stored payload (`{ ...row.payload, ...whatChanged }`)
 * so `correlationId` survives — the dispatch tick terminally fails a payload without one,
 * because `publisher.publish` derives the BullMQ `jobId` from it.
 */

/**
 * The expert has not joined by `scheduled_start + EXPERT_ABSENT_ALERT_MS`. → BALO OPS.
 *
 * ⚠⚠ THIS ALERT IS LOAD-BEARING, NOT FYI. Balo has committed to CONTACTING the expert, so a
 * human has to actually see it — which is why it is `priority: 'critical'` and why
 * `OPS_NOTIFICATION_EMAIL` being unset now produces a boot-time `log.warn` instead of silently
 * no-oping in the dispatcher.
 *
 * ⚠ NO EXPERT NAME AND NO CLIENT NAME. Ops opens the meeting to act on it; a name frozen into a
 * scheduled row would be stale by fire time and is PII sitting in a table for no gain. The
 * template addresses the meeting, not a person.
 */
export interface MeetingExpertAbsentPayload {
  /** ⚠ A FRESH uuid PER PROMISE — never the meeting id. See the module docblock. */
  correlationId: string;
  meetingId: string;
  /** ISO 8601 — the scheduled start the alert is anchored on. */
  scheduledStartIso: string;
  /**
   * Whole minutes from `scheduled_start` to the SCHEDULED fire time. The template states it as
   * a fact ("no one has joined 5 minutes after the scheduled start").
   *
   * ⚠ THE **SCHEDULED** GAP, NOT THE ACTUAL ONE. The recheck may fire late (a backlog, a
   * stranded claim), and re-deriving this at fire time would make the same alert say a
   * different number on a retry. The alert's job is to name the threshold that was crossed.
   */
  minutesPastStart: number;
  /**
   * The meeting's context type — `case` / `project_kickoff` / …. A LABEL, not an id: it tells
   * ops what kind of engagement is at risk without a second lookup, and it is not PII.
   */
  contextType: string;
}

/**
 * The expert is present and no client-side participant has arrived by
 * `clockStart + CLIENT_ABSENT_NUDGE_MS`. → THE CLIENT COMPANY'S LIVE MEMBERS.
 *
 * ⚠ IN-APP + EMAIL ONLY. **SMS IS DEFERRED (D13), NOT DROPPED**, and the AC is amended in the
 * PR rather than quietly reinterpreted. Two independent structural blocks in the SHIPPED
 * adapter and rule layer: `processSmsJob` resolves the number from
 * `usersRepository.findById(payload.recipientId).phone` (so a guest or a delegate with no user
 * row is unreachable BY CONSTRUCTION), and the rule-level `recipientPhoneVerified` gate reads
 * `ctx.data.user`, which the resolver hydrates ONLY on the single-recipient path — never on a
 * fan-out, which is exactly what this nudge is. A follow-up ticket owns a `recipientPhone`
 * payload path plus a fan-out-aware phone gate.
 *
 * ⚠ THE COPY IS A HELPFUL FACT, NEVER A BILLING THREAT. "Your consultation has started — join
 * here." Warm, gender-neutral, no countdown. CLAUDE.md's register rule for prospective copy
 * names the PARTY (the expert's agency, or the independent expert's own name), never a pronoun.
 */
export interface MeetingClientAbsentPayload {
  /** ⚠ A FRESH uuid PER PROMISE — never the meeting id. */
  correlationId: string;
  meetingId: string;
  /**
   * WHO IS NUDGED, resolved BY THE PUBLISHER — which is what keeps a membership read out of
   * `engine/resolver.ts`. The `meeting_party_participants` recipient kind reads exactly this
   * field.
   *
   * ⚠ REBUILT AT FIRE TIME by the recheck: a member who left the company between schedule and
   * fire must not be nudged, and one who joined should be. It is seeded EMPTY at schedule time
   * for that reason — the stored value is never the one that sends.
   *
   * ⚠ TODAY IT IS THE COMPANY'S OWNER/ADMIN MEMBERS, NOT EVERY MEMBER. Stated rather than
   * implied: `partyMembershipsRepository` has no live-member listing, so the widest reachable
   * set is the `MANAGE_MEMBERS` holders — the same fan-out `meeting.guest_added` uses. A plain
   * `member` who booked the consultation is reached through their owner/admin, not directly.
   * See `resolveClientRecipients` in `apps/api` for the follow-up.
   */
  recipientUserIds: string[];
  /**
   * The BOOKING company, carried so the fire-time guard can rebuild `recipientUserIds` without
   * re-resolving the meeting's context — which would be a SECOND answer to "who owns this
   * meeting" and could disagree with the one that armed the promise.
   *
   * ⚠ NOT A DELIVERY TARGET. Nothing in the engine reads it; it is the guard's input.
   */
  companyId: string;
  /** ISO 8601 — the scheduled start, for the "due to start at" line. */
  scheduledStartIso: string;
  /**
   * WHO IS WAITING, as a PARTY name — the expert's agency, or an independent expert's own
   * name. ⚠ `null` ⇒ the template renders party-neutral copy ("your expert"), never a guess.
   */
  waitingPartyName: string | null;
}
