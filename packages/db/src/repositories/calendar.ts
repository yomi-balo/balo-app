import { eq, and, isNull, lt } from 'drizzle-orm';
import { db } from '../client';
import {
  calendarConnections,
  calendarSubCalendars,
  availabilityCache,
  type CalendarConnection,
  type CalendarSubCalendar,
  type NewCalendarSubCalendar,
} from '../schema';

// ── Input types ──────────────────────────────────────────────────

interface UpsertConnectionInput {
  expertProfileId: string;
  cronofySub: string;
  provider: string;
  providerEmail?: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  status?: string;
}

interface UpdateTokensInput {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: Date;
}

interface ReplaceSubCalendarInput {
  calendarId: string;
  name: string;
  provider: string;
  profileName?: string | null;
  isPrimary: boolean;
  conflictCheck: boolean;
  color?: string | null;
}

// ── Repository ───────────────────────────────────────────────────

export const calendarRepository = {
  /** Find calendar connection by expert profile ID (excludes soft-deleted) */
  async findConnectionByExpertProfileId(
    expertProfileId: string
  ): Promise<CalendarConnection | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
    });
  },

  /** Find calendar connection by push notification channel ID */
  async findConnectionByChannelId(channelId: string): Promise<CalendarConnection | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.channelId, channelId),
        isNull(calendarConnections.deletedAt)
      ),
    });
  },

  /** Upsert calendar connection — inserts or updates on expertProfileId conflict */
  async upsertConnection(data: UpsertConnectionInput): Promise<CalendarConnection> {
    const [result] = await db
      .insert(calendarConnections)
      .values({
        expertProfileId: data.expertProfileId,
        cronofySub: data.cronofySub,
        provider: data.provider,
        providerEmail: data.providerEmail ?? null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        status: data.status ?? 'connected',
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [calendarConnections.expertProfileId],
        set: {
          cronofySub: data.cronofySub,
          provider: data.provider,
          providerEmail: data.providerEmail ?? null,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          tokenExpiresAt: data.tokenExpiresAt,
          status: data.status ?? 'connected',
          updatedAt: new Date(),
          deletedAt: null,
        },
      })
      .returning();

    return result!;
  },

  /** Update access token (and optionally refresh token) + expiry */
  async updateConnectionTokens(expertProfileId: string, data: UpdateTokensInput): Promise<void> {
    await db
      .update(calendarConnections)
      .set({
        accessToken: data.accessToken,
        ...(data.refreshToken !== undefined && { refreshToken: data.refreshToken }),
        tokenExpiresAt: data.tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /** Update connection status */
  async updateConnectionStatus(expertProfileId: string, status: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /** Update push notification channel ID */
  async updateConnectionChannelId(expertProfileId: string, channelId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ channelId, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /** Update lastSyncedAt for a connection (by connection ID) */
  async updateLastSyncedAt(connectionId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(calendarConnections.id, connectionId));
  },

  /** Set the target calendar ID for event writes */
  async updateTargetCalendarId(expertProfileId: string, targetCalendarId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ targetCalendarId, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /** Soft-delete a calendar connection */
  async softDeleteConnection(expertProfileId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /** Find connected connections whose lastSyncedAt is before the threshold */
  async findStaleConnections(threshold: Date): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.status, 'connected'),
        isNull(calendarConnections.deletedAt),
        lt(calendarConnections.lastSyncedAt, threshold)
      ),
    });
  },

  // ── Sub-calendar methods ────────────────────────────────────────

  /** Find all sub-calendars for a connection */
  async findSubCalendarsByConnectionId(connectionId: string): Promise<CalendarSubCalendar[]> {
    return db.query.calendarSubCalendars.findMany({
      where: eq(calendarSubCalendars.connectionId, connectionId),
    });
  },

  /** Replace all sub-calendars for a connection (delete + re-insert in tx) */
  async replaceSubCalendars(
    connectionId: string,
    calendars: ReplaceSubCalendarInput[]
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(calendarSubCalendars)
        .where(eq(calendarSubCalendars.connectionId, connectionId));

      if (calendars.length > 0) {
        await tx.insert(calendarSubCalendars).values(
          calendars.map(
            (cal): NewCalendarSubCalendar => ({
              connectionId,
              calendarId: cal.calendarId,
              name: cal.name,
              provider: cal.provider,
              profileName: cal.profileName ?? null,
              isPrimary: cal.isPrimary,
              conflictCheck: cal.conflictCheck,
              color: cal.color ?? null,
            })
          )
        );
      }
    });
  },

  /** Update conflict-check toggle for a specific sub-calendar */
  async updateConflictCheck(
    connectionId: string,
    calendarId: string,
    conflictCheck: boolean
  ): Promise<void> {
    await db
      .update(calendarSubCalendars)
      .set({ conflictCheck, updatedAt: new Date() })
      .where(
        and(
          eq(calendarSubCalendars.connectionId, connectionId),
          eq(calendarSubCalendars.calendarId, calendarId)
        )
      );
  },

  /** Find a specific sub-calendar by calendarId within a connection */
  async findSubCalendarByCalendarId(
    connectionId: string,
    calendarId: string
  ): Promise<CalendarSubCalendar | undefined> {
    return db.query.calendarSubCalendars.findFirst({
      where: and(
        eq(calendarSubCalendars.connectionId, connectionId),
        eq(calendarSubCalendars.calendarId, calendarId)
      ),
    });
  },

  /** Delete all sub-calendars for a connection */
  async deleteSubCalendarsByConnectionId(connectionId: string): Promise<void> {
    await db
      .delete(calendarSubCalendars)
      .where(eq(calendarSubCalendars.connectionId, connectionId));
  },

  // ── Availability cache methods ─────────────────────────────────

  /** Upsert availability cache for an expert */
  async upsertAvailabilityCache(
    expertProfileId: string,
    earliestAvailableAt: Date | null
  ): Promise<void> {
    await db
      .insert(availabilityCache)
      .values({
        expertProfileId,
        earliestAvailableAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [availabilityCache.expertProfileId],
        set: {
          earliestAvailableAt,
          updatedAt: new Date(),
        },
      });
  },

  /** Clear availability cache for an expert (set earliestAvailableAt to null) */
  async clearAvailabilityCache(expertProfileId: string): Promise<void> {
    await db
      .insert(availabilityCache)
      .values({
        expertProfileId,
        earliestAvailableAt: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [availabilityCache.expertProfileId],
        set: {
          earliestAvailableAt: null,
          updatedAt: new Date(),
        },
      });
  },

  // ── Compound queries ───────────────────────────────────────────

  /** Find connection with all sub-calendars included */
  async findConnectionWithSubCalendars(
    expertProfileId: string
  ): Promise<(CalendarConnection & { subCalendars: CalendarSubCalendar[] }) | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
      with: { subCalendars: true },
    });
  },
};
