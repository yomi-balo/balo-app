import { describe, it, expect } from 'vitest';
import { deriveSlotState } from './calendar-slot-state';
import type { CalendarConnection } from '../_types/calendar';

function buildConnection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    provider: 'google',
    credentialStatus: 'ACTIVE',
    providerEmail: 'dana@example.com',
    lastSyncedAt: null,
    targetCalendarId: null,
    subCalendars: [],
    ...overrides,
  };
}

describe('deriveSlotState', () => {
  // ── No connection, no transient ──────────────────────────────
  it('idle when there is no connection and no transient', () => {
    expect(deriveSlotState({ connection: undefined, transient: undefined })).toBe('idle');
  });

  // ── In-flight transients always win, connection or not ───────
  it.each([
    ['o365_guidance', 'o365_guidance'],
    ['o365_waiting', 'o365_waiting'],
    ['connecting', 'connecting'],
  ] as const)('transient %s wins even with a live connection present', (transient, expected) => {
    expect(
      deriveSlotState({ connection: buildConnection({ credentialStatus: 'EXPIRED' }), transient })
    ).toBe(expected);
  });

  it.each(['o365_guidance', 'o365_waiting', 'connecting'] as const)(
    'transient %s wins with no connection',
    (transient) => {
      expect(deriveSlotState({ connection: undefined, transient })).toBe(transient);
    }
  );

  // ── attempt_failed only takes the card when there's no row ───
  it('attempt_failed with no connection renders attempt_failed', () => {
    expect(deriveSlotState({ connection: undefined, transient: 'attempt_failed' })).toBe(
      'attempt_failed'
    );
  });

  it('attempt_failed with a live connection defers to the connection status (never hides reconnect_needed)', () => {
    expect(
      deriveSlotState({
        connection: buildConnection({ credentialStatus: 'EXPIRED' }),
        transient: 'attempt_failed',
      })
    ).toBe('reconnect_needed');
  });

  it('attempt_failed with an ACTIVE connection defers to connected', () => {
    expect(
      deriveSlotState({
        connection: buildConnection({ credentialStatus: 'ACTIVE' }),
        transient: 'attempt_failed',
      })
    ).toBe('connected');
  });

  // ── Credential status → slot state, full 4x2 table ────────────
  it.each([
    ['ACTIVE', 'connected'],
    ['SYNC_PENDING', 'setting_up'],
    ['EXPIRED', 'reconnect_needed'],
    ['REVOKED', 'reconnect_needed'],
  ] as const)('credentialStatus %s -> slot %s (no transient)', (credentialStatus, expected) => {
    expect(
      deriveSlotState({ connection: buildConnection({ credentialStatus }), transient: undefined })
    ).toBe(expected);
  });

  // apiroc skill: EXPIRED and REVOKED must render the SAME UX, no distinct branch.
  it('EXPIRED and REVOKED render identically', () => {
    const expired = deriveSlotState({
      connection: buildConnection({ credentialStatus: 'EXPIRED' }),
      transient: undefined,
    });
    const revoked = deriveSlotState({
      connection: buildConnection({ credentialStatus: 'REVOKED' }),
      transient: undefined,
    });
    expect(expired).toBe(revoked);
    expect(expired).toBe('reconnect_needed');
  });
});
