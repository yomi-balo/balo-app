import { describe, expect, it } from 'vitest';
import { AIRWALLEX_DETAIL_LIMIT, AirwallexApiError, AirwallexAuthError } from './errors.js';

describe('Airwallex errors', () => {
  const long = 'a'.repeat(3000);

  it('caps the detail embedded in the API error message but keeps the full detail', () => {
    const err = new AirwallexApiError(500, '/x', long);
    expect(err.message).toBe(
      `Airwallex API error 500 at /x: ${'a'.repeat(AIRWALLEX_DETAIL_LIMIT)}`
    );
    expect(err.detail).toHaveLength(3000);
  });

  it('caps the detail embedded in the auth error message but keeps the full detail', () => {
    const err = new AirwallexAuthError(long, 401);
    expect(err.message).toBe(`Airwallex auth failed: ${'a'.repeat(AIRWALLEX_DETAIL_LIMIT)}`);
    expect(err.detail).toHaveLength(3000);
  });
});
