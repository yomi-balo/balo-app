import { createRequire } from 'node:module';
import type { RuleContext } from './rules.js';

export async function resolveContext(
  event: string,
  payload: Record<string, unknown>
): Promise<RuleContext> {
  // Lazy require -- @balo/db is CJS; top-level import breaks Vitest transforms
  const { usersRepository } = createRequire(import.meta.url)('@balo/db');

  const data: Record<string, unknown> = {};

  // Hydrate the user (present in all current events)
  if (typeof payload.userId === 'string') {
    data.user = await usersRepository.findById(payload.userId);
  }

  return { event, payload, data };
}
