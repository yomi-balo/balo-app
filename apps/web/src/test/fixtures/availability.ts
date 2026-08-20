/**
 * Shared BAL-236 availability test fixtures. Centralises the `GET /experts/:id/availability`
 * response factories that `ExpertAvailabilityCalendar.test.tsx` and
 * `use-expert-availability.test.ts` both need, so each spec no longer copies the same object
 * literal (keeps new-code duplication under the SonarCloud gate — see `promo-codes.ts` for the
 * precedent). Lives under `src/test/fixtures/**` — classified as test code by
 * `sonar.test.inclusions` and excluded from coverage by the vitest config.
 */

export const AVAILABILITY_EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

/** A minimal fetch-shaped `Response` stub — status + a `json()` resolving to `body`. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A valid `status: 'ok'` availability body — two slots on 2026-06-05, UTC. */
export function okAvailabilityBody(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    expertProfileId: AVAILABILITY_EXPERT_ID,
    status: 'ok',
    expertTimezone: 'UTC',
    generatedAt: '2026-06-01T00:00:00.000Z',
    windowEnd: '2026-06-15T00:00:00.000Z',
    days: 14,
    slots: [
      { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
      { start: '2026-06-05T10:00:00.000Z', end: '2026-06-05T10:30:00.000Z', maxDuration: 30 },
    ],
    ...overrides,
  };
}
