import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Railway's pre-deploy `db:migrate` applies whatever drizzle's migrator considers pending, and
 * nobody watches it. Four journal shapes make the migrator skip a migration WITHOUT an error:
 *
 * 1. It reads only `meta/_journal.json`, in array order, and applies an entry only when its
 *    `when` is greater than the newest `created_at` in `drizzle.__drizzle_migrations`. An entry
 *    whose `when` is not greater than the one before it — a hand-resolved journal merge, or a
 *    migration generated on a branch before a sibling that merged first — is skipped once the
 *    sibling has been applied.
 * 2. A branch's entry slotted in BEFORE an already-merged one with the same number ("accept
 *    both" in the wrong order) keeps `when` increasing, but is skipped for the same reason once
 *    the merged one has been applied. Each entry's number must equal its position.
 * 3. An `.sql` file with no journal entry is never read at all.
 * 4. A `when` in the future, once applied, puts the tracker's newest `created_at` ahead of the
 *    clock: every migration generated before that moment is skipped unless its `when` is raised
 *    past it by hand.
 *
 * Renumbering a migration during a rebase keeps its old `when`; regenerate it, or raise `when` to
 * a time after everything already on main but not in the future.
 */

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const { entries } = JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, 'utf8')) as {
  entries: readonly JournalEntry[];
};
const sqlTags = readdirSync(DRIZZLE_DIR)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => file.slice(0, -'.sql'.length));

describe('invariant: no migration is silently skipped', () => {
  it('reads the journal and the migration files (non-vacuity guard)', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(sqlTags.length).toBeGreaterThan(100);
  });

  it('gives every journal entry a later `when` than the entry before it', () => {
    const outOfOrder = entries.flatMap((entry, index) => {
      const previous = entries[index - 1];
      return previous !== undefined && entry.when <= previous.when
        ? [`${previous.tag} (${previous.when}) → ${entry.tag} (${entry.when})`]
        : [];
    });

    expect(outOfOrder).toEqual([]);
  });

  it('dates no journal entry in the future', () => {
    // The clock only moves forward, so this can turn green on its own but never red.
    const now = Date.now();

    expect(entries.filter((entry) => entry.when > now).map((entry) => entry.tag)).toEqual([]);
  });

  it('numbers every journal entry by its position', () => {
    const misnumbered = entries.flatMap((entry, index) =>
      entry.idx === index && entry.tag.startsWith(`${String(index).padStart(4, '0')}_`)
        ? []
        : [`position ${index}: ${entry.tag} (idx ${entry.idx})`]
    );

    expect(misnumbered).toEqual([]);
  });

  it('has a journal entry for every .sql file, and a .sql file for every entry', () => {
    const journalTags = entries.map((entry) => entry.tag);

    expect(sqlTags.filter((tag) => !journalTags.includes(tag))).toEqual([]);
    expect(journalTags.filter((tag) => !sqlTags.includes(tag))).toEqual([]);
  });
});
