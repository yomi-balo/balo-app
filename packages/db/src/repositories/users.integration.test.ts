import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { userFactory } from '../test/factories';
import { usersRepository } from './users';

describe('usersRepository.update', () => {
  it('updates country and countryCode fields', async () => {
    const user = await userFactory({ country: 'Australia', countryCode: 'AU' });

    const updated = await usersRepository.update(user.id, {
      country: 'United States',
      countryCode: 'US',
    });

    expect(updated.id).toBe(user.id);
    expect(updated.country).toBe('United States');
    expect(updated.countryCode).toBe('US');
  });

  it('sets countryCode to null when explicitly passed', async () => {
    const user = await userFactory({ country: 'Australia', countryCode: 'AU' });
    expect(user.countryCode).toBe('AU');

    const updated = await usersRepository.update(user.id, { countryCode: null });

    expect(updated.countryCode).toBeNull();
  });

  it('does not affect unrelated fields when not passed', async () => {
    const user = await userFactory({
      firstName: 'Alice',
      lastName: 'Smith',
      country: 'Australia',
      countryCode: 'AU',
    });

    const updated = await usersRepository.update(user.id, { country: 'Germany' });

    expect(updated.country).toBe('Germany');
    // Unrelated fields should remain unchanged
    expect(updated.email).toBe(user.email);
    expect(updated.firstName).toBe('Alice');
    expect(updated.lastName).toBe('Smith');
    expect(updated.countryCode).toBe('AU');
  });

  it('returns undefined (cast as User) for a non-existent userId', async () => {
    const nonExistentId = randomUUID();

    // The repository does `return user!` which is a TS-only assertion.
    // At runtime, destructuring an empty array gives undefined.
    const result = await usersRepository.update(nonExistentId, { country: 'Germany' });

    expect(result).toBeUndefined();
  });
});
