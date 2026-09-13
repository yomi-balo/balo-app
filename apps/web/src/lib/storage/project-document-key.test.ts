import { describe, it, expect } from 'vitest';
import {
  isSessionOwnedProjectDocumentKey,
  PROJECT_DOCUMENT_KEY_PATTERN,
} from './project-document-key';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const OTHER_COMPANY = '99999999-9999-9999-9999-999999999999';
const OBJECT_ID = '33333333-3333-3333-3333-333333333333';

describe('PROJECT_DOCUMENT_KEY_PATTERN', () => {
  it('matches the exact shape', () => {
    expect(
      PROJECT_DOCUMENT_KEY_PATTERN.test(`project-documents/${COMPANY}/${USER}/${OBJECT_ID}`)
    ).toBe(true);
  });

  it('rejects a path-traversal attempt', () => {
    expect(
      PROJECT_DOCUMENT_KEY_PATTERN.test(`project-documents/${COMPANY}/../${USER}/${OBJECT_ID}`)
    ).toBe(false);
  });

  it('rejects a wrong-length segment', () => {
    expect(PROJECT_DOCUMENT_KEY_PATTERN.test(`project-documents/short/${USER}/${OBJECT_ID}`)).toBe(
      false
    );
  });
});

describe('isSessionOwnedProjectDocumentKey', () => {
  const owner = { companyId: COMPANY, userId: USER };

  it('accepts the exact owner key', () => {
    expect(
      isSessionOwnedProjectDocumentKey(`project-documents/${COMPANY}/${USER}/${OBJECT_ID}`, owner)
    ).toBe(true);
  });

  it('rejects a key scoped to a different company', () => {
    expect(
      isSessionOwnedProjectDocumentKey(
        `project-documents/${OTHER_COMPANY}/${USER}/${OBJECT_ID}`,
        owner
      )
    ).toBe(false);
  });

  it('rejects a key scoped to a different user', () => {
    const otherUser = '44444444-4444-4444-4444-444444444444';
    expect(
      isSessionOwnedProjectDocumentKey(
        `project-documents/${COMPANY}/${otherUser}/${OBJECT_ID}`,
        owner
      )
    ).toBe(false);
  });

  it('rejects a malformed key entirely', () => {
    expect(isSessionOwnedProjectDocumentKey('not-a-project-document-key', owner)).toBe(false);
  });

  it('rejects a path-traversal key even if it happens to start with the right prefix text', () => {
    expect(
      isSessionOwnedProjectDocumentKey(`project-documents/${COMPANY}/${USER}/../../secret`, owner)
    ).toBe(false);
  });
});
