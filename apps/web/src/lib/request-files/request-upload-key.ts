import { REQUEST_FILE_PREFIX } from '@/lib/storage/request-file';

const UUID_RE = /^[0-9a-f-]{36}$/;

const INVALID_UPLOAD_KEY = 'Invalid upload key.';

/**
 * Key shape + provenance (BAL-431 §7.5): the request comes from the VALIDATED gate, the user
 * from the session. Segment-split, NOT a regex over the whole key, which keeps it clear of a
 * ReDoS-shaped pattern, and it destructures-and-guards rather than asserting an index.
 *
 * Shared by the confirm and discard actions so "this is the caller's own upload key" has one
 * definition. It lives here because a `'use server'` module cannot export a non-action value.
 *
 * Returns the error copy, or `null` when the key is valid.
 */
export function validateRequestUploadKey(
  key: string,
  projectRequestId: string,
  userId: string
): string | null {
  const [prefix, keyRequestId, keyUserId, leaf, ...extra] = key.split('/');
  if (extra.length > 0) return INVALID_UPLOAD_KEY;
  if (`${prefix}/` !== REQUEST_FILE_PREFIX) return INVALID_UPLOAD_KEY;
  if (keyRequestId !== projectRequestId) return INVALID_UPLOAD_KEY;
  if (keyUserId !== userId) return INVALID_UPLOAD_KEY;
  if (leaf === undefined || !UUID_RE.test(leaf)) return INVALID_UPLOAD_KEY;
  return null;
}
