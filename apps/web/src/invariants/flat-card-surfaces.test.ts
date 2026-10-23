import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, resolveRouteDir } from './_source-scan';

/**
 * BAL-618 — "Flat everywhere": the files that DEFINE a Balo card surface carry no shadow.
 *
 * Deliberately narrow (no repo-wide scan): buttons, chips, avatars, active tabs, sticky bars and
 * floating layers legitimately keep a shadow. A re-added `shadow-*` on one of these four files
 * would silently re-elevate every card built on it.
 */

interface CardDefinition {
  readonly label: string;
  readonly path: string;
  /** A string that IS genuinely in the file — the non-vacuity anchor. */
  readonly present: string;
}

const definition = (label: string, relative: string, present: string): CardDefinition => ({
  label,
  path: resolveRouteDir([`src/${relative}`, `apps/web/src/${relative}`]),
  present,
});

const DEFINITIONS: readonly CardDefinition[] = [
  definition('BaloCard primitive', 'components/balo/card/balo-card.tsx', 'baloCardClassName'),
  definition('RequestCard', 'components/balo/project-request/request-card.tsx', 'BaloCard'),
  definition('SectionCard', 'components/balo/section/section-states.tsx', 'BaloCard'),
  definition('shadcn Card', 'components/ui/card.tsx', 'data-slot="card"'),
];

describe('invariant: card-defining files are flat (BAL-618)', () => {
  it.each(DEFINITIONS)(
    'guards the guard: the $label file resolves on disk and genuinely contains $present',
    ({ path, present }) => {
      expect(path).not.toBe('');
      expect(codeLinesOf(readFileSync(path, 'utf8'))).toContain(present);
    }
  );

  it.each(DEFINITIONS)('the $label file contains no shadow utility', ({ label, path }) => {
    const code = codeLinesOf(readFileSync(path, 'utf8'));
    expect(
      /\bshadow(\b|-)/.test(code),
      `${label} reintroduces a shadow. BAL-618 "Flat everywhere": cards are a border on an ` +
        `atmospheric background, never elevated. Shadows are for floating layers only.`
    ).toBe(false);
  });
});
