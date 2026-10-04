import { describe, it, expect } from 'vitest';
import { PERSON_NAME_MAX, changedNameFields, personNameSchema } from './name-schema';

describe('personNameSchema', () => {
  it('accepts a first and last name, trimmed', () => {
    expect(personNameSchema.parse({ firstName: '  Dana ', lastName: ' Reyes ' })).toEqual({
      firstName: 'Dana',
      lastName: 'Reyes',
    });
  });

  it.each([
    [{ firstName: ' ', lastName: 'Reyes' }, 'First name is required'],
    [{ firstName: 'Dana', lastName: '' }, 'Last name is required'],
    [{ firstName: 'a'.repeat(PERSON_NAME_MAX + 1), lastName: 'Reyes' }, 'First name is too long'],
    [{ firstName: 'Dana', lastName: '<b>Reyes</b>' }, 'Name contains invalid characters'],
  ])('refuses %o with "%s"', (input, message) => {
    const result = personNameSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('allows exactly the maximum length', () => {
    expect(
      personNameSchema.safeParse({ firstName: 'a'.repeat(PERSON_NAME_MAX), lastName: 'Reyes' })
        .success
    ).toBe(true);
  });
});

describe('changedNameFields', () => {
  it('names each part that changed, comparing trimmed values', () => {
    expect(
      changedNameFields(
        { firstName: 'Ada', lastName: 'Lovelace' },
        { firstName: 'Augusta', lastName: 'King' }
      )
    ).toEqual(['first_name', 'last_name']);
    expect(
      changedNameFields(
        { firstName: 'Ada', lastName: 'Lovelace' },
        { firstName: ' Ada ', lastName: 'King' }
      )
    ).toEqual(['last_name']);
  });

  it('treats a missing previous part as empty', () => {
    expect(
      changedNameFields(
        { firstName: 'Ada', lastName: null },
        { firstName: 'Ada', lastName: 'King' }
      )
    ).toEqual(['last_name']);
  });
});
