/**
 * `clientId` → first name for the "typing…" line.
 *
 * An Ably `clientId` on the typing channel IS `users.id` (the token mint stamps it), so the only
 * question is which name to show. The answer comes from data the surface ALREADY holds — message
 * senders and file uploaders — and never from a new server read: the typing path reads no
 * payload, and inventing a lookup for it would widen what a typing event can make the page fetch.
 * An id that no loaded row names resolves to `null`, which the copy renders as "Someone".
 */

/**
 * The name the conversation view mappers substitute when a user has neither a first nor a last
 * name (`lib/conversations/conversation-view.ts`, and the post/fetch actions that mirror it).
 *
 * ⚠ DUPLICATED HERE, NOT IMPORTED, BECAUSE THAT MODULE IS `server-only`. This file is imported by
 * the client conversation islands, and `server-only` fails any client bundle that reaches it.
 * `typing-names.test.ts` pins the copy against the two `conversation-view.ts` mappers' own output
 * for a nameless user. ⚠ ONLY THOSE TWO: the post actions that build a live message view spell
 * the same literal independently and are NOT covered, so a change to one of them would surface
 * as "{fallback} is typing…" with every test green. Showing it would read "Participant is
 * typing…", a placeholder dressed up as a name.
 */
const PARTICIPANT_FALLBACK_NAME = 'Participant';

/** One person as a surface already knows them: a message sender or a file uploader. */
export interface TypingPerson {
  readonly userId: string;
  readonly name: string;
}

function firstNameOf(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === PARTICIPANT_FALLBACK_NAME) return null;
  const [first] = trimmed.split(/\s/, 1);
  return first ?? null;
}

/**
 * Map each user id to the first whitespace token of their trimmed display name.
 *
 * Empty names and the mapper fallback are skipped, so a later row that does carry a real name
 * still fills the entry. The FIRST real name for an id wins: rows for one user carry the same
 * name in practice, and first-wins keeps the entry from flipping as a thread appends rows.
 */
export function firstNamesByUserId(people: readonly TypingPerson[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const { userId, name } of people) {
    if (names.has(userId)) continue;
    const first = firstNameOf(name);
    if (first !== null) names.set(userId, first);
  }
  return names;
}

/** Resolve typing ids to first names in the same order; `null` means "nobody we can name". */
export function resolveTypingNames(
  typingClientIds: readonly string[],
  namesByUserId: ReadonlyMap<string, string>
): readonly (string | null)[] {
  return typingClientIds.map((id) => namesByUserId.get(id) ?? null);
}
