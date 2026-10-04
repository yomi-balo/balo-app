import { z } from 'zod';

/**
 * A person's first + last name — the ONE rule, read by `updateNameAction` on the server and by
 * every form that edits a name, so the browser and the server can never disagree on what a
 * valid name is. Plain zod only: client-safe, and kept out of the `'use server'` action module
 * because that file may export async functions only.
 */
export const personNameSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'First name is required')
    .max(50, 'First name is too long')
    .regex(/^[^<>]*$/, 'Name contains invalid characters'),
  lastName: z
    .string()
    .trim()
    .min(1, 'Last name is required')
    .max(50, 'Last name is too long')
    .regex(/^[^<>]*$/, 'Name contains invalid characters'),
});

/** The longest a single name part may be — mirrors the schema for `maxLength` on inputs. */
export const PERSON_NAME_MAX = 50;

/** Which part(s) of a name changed, as analytics field names — trimmed comparison. */
export function changedNameFields(
  before: Readonly<{ firstName?: string | null; lastName?: string | null }>,
  after: Readonly<{ firstName: string; lastName: string }>
): Array<'first_name' | 'last_name'> {
  const fields: Array<'first_name' | 'last_name'> = [];
  if ((before.firstName ?? '').trim() !== after.firstName.trim()) fields.push('first_name');
  if ((before.lastName ?? '').trim() !== after.lastName.trim()) fields.push('last_name');
  return fields;
}
