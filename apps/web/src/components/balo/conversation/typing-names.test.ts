import { describe, expect, it, vi } from 'vitest';
import type { ConversationFile } from '@balo/db';

/**
 * `clientId` → first name for the "typing…" line.
 *
 * ⚠ THE `'Participant'` SKIP IS PINNED AGAINST THE SERVER MAPPERS' OWN OUTPUT, not against a
 * literal. `typing-names.ts` cannot import the fallback from the `server-only` view module, so
 * it carries a copy; the drift block below builds a nameless sender and a nameless uploader
 * through the real `conversation-view.ts` mappers and requires both to resolve to "unknown", so
 * renaming the fallback in those mappers or here alone fails. (The post actions' own copies of
 * the literal are outside this pin — see `typing-names.ts`.)
 */

vi.mock('server-only', () => ({}));

import {
  mapConversationFileRowToView,
  mapMessageRowToView,
} from '@/lib/conversations/conversation-view';
import { firstNamesByUserId, resolveTypingNames } from './typing-names';

describe('firstNamesByUserId', () => {
  it('takes the first whitespace token of each name', () => {
    const names = firstNamesByUserId([
      { userId: 'u-dana', name: 'Dana Okafor' },
      { userId: 'u-sam', name: 'Sam Lee Chen' },
      { userId: 'u-kai', name: 'Kai' },
    ]);

    expect([...names]).toEqual([
      ['u-dana', 'Dana'],
      ['u-sam', 'Sam'],
      ['u-kai', 'Kai'],
    ]);
  });

  it('trims before splitting, and splits on any whitespace', () => {
    const names = firstNamesByUserId([
      { userId: 'u-dana', name: '   Dana   Okafor ' },
      { userId: 'u-sam', name: 'Sam\tLee' },
      { userId: 'u-kai', name: 'Kai\u00a0Moana' },
    ]);

    expect([...names]).toEqual([
      ['u-dana', 'Dana'],
      ['u-sam', 'Sam'],
      ['u-kai', 'Kai'],
    ]);
  });

  it('skips empty and whitespace-only names', () => {
    const names = firstNamesByUserId([
      { userId: 'u-empty', name: '' },
      { userId: 'u-blank', name: '   ' },
    ]);

    expect(names.size).toBe(0);
  });

  it('skips the "Participant" placeholder', () => {
    const names = firstNamesByUserId([{ userId: 'u-anon', name: 'Participant' }]);

    expect(names.size).toBe(0);
  });

  it('a later real name fills an entry an earlier placeholder or blank left empty', () => {
    const names = firstNamesByUserId([
      { userId: 'u-dana', name: 'Participant' },
      { userId: 'u-dana', name: ' ' },
      { userId: 'u-dana', name: 'Dana Okafor' },
    ]);

    expect([...names]).toEqual([['u-dana', 'Dana']]);
  });

  it('later duplicates neither break nor overwrite the first real name', () => {
    const names = firstNamesByUserId([
      { userId: 'u-dana', name: 'Dana Okafor' },
      { userId: 'u-sam', name: 'Sam Lee' },
      { userId: 'u-dana', name: 'Dana Okafor' },
      { userId: 'u-dana', name: 'Danielle Okafor' },
      { userId: 'u-dana', name: 'Participant' },
    ]);

    expect([...names]).toEqual([
      ['u-dana', 'Dana'],
      ['u-sam', 'Sam'],
    ]);
  });

  describe('⚠ drift pin — the server mappers’ fallback is what gets skipped', () => {
    it('a nameless message sender resolves to unknown', () => {
      const view = mapMessageRowToView({
        id: 'msg-1',
        conversationId: 'cv-1',
        senderUserId: 'u-anon',
        body: '<p>hi</p>',
        senderFirstName: null,
        senderLastName: null,
        createdAt: new Date('2026-09-01T09:00:00Z'),
      } as unknown as Parameters<typeof mapMessageRowToView>[0]);

      const names = firstNamesByUserId([{ userId: view.senderUserId, name: view.senderName }]);

      expect(resolveTypingNames(['u-anon'], names)).toEqual([null]);
    });

    it('an unresolved file uploader resolves to unknown', () => {
      const view = mapConversationFileRowToView(
        {
          id: 'cf-1',
          conversationId: 'cv-1',
          uploadedByUserId: 'u-anon',
          fileName: 'deck.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1,
          createdAt: new Date('2026-09-01T09:00:00Z'),
        } as unknown as ConversationFile,
        new Map()
      );

      const names = firstNamesByUserId([
        { userId: view.uploadedByUserId, name: view.uploadedByName },
      ]);

      expect(resolveTypingNames(['u-anon'], names)).toEqual([null]);
    });
  });
});

describe('resolveTypingNames', () => {
  const names = firstNamesByUserId([
    { userId: 'u-dana', name: 'Dana Okafor' },
    { userId: 'u-sam', name: 'Sam Lee' },
  ]);

  it('maps ids to first names in the given order', () => {
    expect(resolveTypingNames(['u-sam', 'u-dana'], names)).toEqual(['Sam', 'Dana']);
  });

  it('maps an id no loaded row names to null', () => {
    expect(resolveTypingNames(['u-dana', 'u-stranger'], names)).toEqual(['Dana', null]);
  });

  it('maps nobody typing to an empty list', () => {
    expect(resolveTypingNames([], names)).toEqual([]);
  });
});
