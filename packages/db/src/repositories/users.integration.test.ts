import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { userFactory } from '../test/factories';
import { usersRepository } from './users';

describe('usersRepository.setPhoneVerified', () => {
  it('writes phone and phoneVerifiedAt atomically', async () => {
    const user = await userFactory();
    const phone = '+61412345678';
    const verifiedAt = new Date('2026-01-15T10:00:00Z');

    const result = await usersRepository.setPhoneVerified(user.id, phone, verifiedAt);

    expect(result.id).toBe(user.id);
    expect(result.phone).toBe(phone);
    expect(result.phoneVerifiedAt).toEqual(verifiedAt);
  });

  it('bumps updatedAt', async () => {
    const user = await userFactory();
    const before = user.updatedAt;

    const result = await usersRepository.setPhoneVerified(user.id, '+61400000000', new Date());

    expect(result.updatedAt!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });

  it('returns undefined for a non-existent userId', async () => {
    const nonExistentId = randomUUID();

    const result = await usersRepository.setPhoneVerified(
      nonExistentId,
      '+61412345678',
      new Date()
    );

    expect(result).toBeUndefined();
  });
});

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
