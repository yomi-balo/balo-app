import { describe, it, expect } from 'vitest';
import { validateRequestUploadKey } from './request-upload-key';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const LEAF = 'c0000000-0000-4000-8000-000000000003';
const VALID = `request-files/${REQUEST_ID}/${USER_ID}/${LEAF}`;

describe('validateRequestUploadKey', () => {
  it('accepts the caller’s own key on this request', () => {
    expect(validateRequestUploadKey(VALID, REQUEST_ID, USER_ID)).toBeNull();
  });

  it.each([
    ['another request', `request-files/other/${USER_ID}/${LEAF}`],
    ['another user', `request-files/${REQUEST_ID}/other/${LEAF}`],
    ['a foreign prefix', `conversation-files/${REQUEST_ID}/${USER_ID}/${LEAF}`],
    ['a non-uuid leaf', `request-files/${REQUEST_ID}/${USER_ID}/not-a-uuid`],
    ['a missing leaf', `request-files/${REQUEST_ID}/${USER_ID}`],
    ['an extra segment', `${VALID}/extra`],
    ['an empty key', ''],
  ])('rejects %s', (_label, key) => {
    expect(validateRequestUploadKey(key, REQUEST_ID, USER_ID)).toBe('Invalid upload key.');
  });
});
