import type { CalendarConnection } from '../../schema';
import { calendarRepository, type UpsertApirocConnectionInput } from '../../repositories/calendar';

/**
 * Seed a live Apiroc connection for a fixture and return the row.
 *
 * `upsertApirocConnection` answers a discriminated result since BAL-575, because a
 * reconnect with a different End User Account is refused rather than written. A fixture
 * that only needs a row must not quietly carry on after a refusal: every later assertion
 * would run against a row that was never written. This throws instead, naming the expert
 * and provider so the failure points at the seed rather than at the assertion after it.
 *
 * Tests whose SUBJECT is the upsert call the repository directly and assert `outcome`.
 */
export async function seedApirocConnection(
  input: UpsertApirocConnectionInput
): Promise<CalendarConnection> {
  const result = await calendarRepository.upsertApirocConnection(input);
  if (result.outcome !== 'persisted') {
    throw new Error(
      `seedApirocConnection: the upsert for expert ${input.expertProfileId} / provider ` +
        `${input.provider} was refused (${result.outcome}). A live row for that pair already ` +
        'holds a different End User Account.'
    );
  }
  return result.connection;
}
