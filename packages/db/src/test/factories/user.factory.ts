import { usersRepository } from '../../repositories/users';
import type { NewUser, User } from '../../schema/users';

let seq = 0;

export async function userFactory(overrides: Partial<NewUser> = {}): Promise<User> {
  seq++;
  return usersRepository.create({
    workosId: `test-workos-${seq}-${Date.now()}`,
    email: `user${seq}-${Date.now()}@test.com`,
    firstName: 'Test',
    lastName: `User${seq}`,
    country: 'Australia',
    countryCode: 'AU',
    ...overrides,
  });
}
