import { describe, expect, it } from 'vitest';
import * as projectRequests from '@balo/shared/project-requests';
import { REMINDER_SEQUENCE_SHARED_RULES } from '@balo/shared/notifications';
import { codeLinesOf, namedImportsFrom, scanWorkspaceSources } from './_source-scan';

/**
 * The rules a reminder sequence's finder shares with the dashboard live in `@balo/shared` and
 * nowhere else. `REMINDER_SEQUENCE_SHARED_RULES` names them; for each name this file pins that
 * the shared package exports a function of that name, that no `apps/web/src` file declares its
 * own copy, and that every web file mentioning the name imports it from the shared home.
 */

const SHARED_HOME = '@balo/shared/project-requests';
const WEB_PREFIX = 'apps/web/src/';

const RULE_NAMES: readonly string[] = [
  ...new Set(Object.values(REMINDER_SEQUENCE_SHARED_RULES).flat()),
];

const webFiles = scanWorkspaceSources().filter((f) => f.rel.startsWith(WEB_PREFIX));

function declaresName(code: string, name: string): boolean {
  return codeLinesOf(code)
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith(`function ${name}`) ||
        trimmed.startsWith(`export function ${name}`) ||
        trimmed.startsWith(`export async function ${name}`) ||
        trimmed.startsWith(`async function ${name}`) ||
        trimmed.startsWith(`const ${name} `) ||
        trimmed.startsWith(`let ${name} `) ||
        trimmed.startsWith(`export const ${name} `) ||
        trimmed.startsWith(`export let ${name} `) ||
        (trimmed.startsWith('export {') && trimmed.includes(` as ${name}`))
      );
    });
}

describe('reminder-sequence shared rules have one home', () => {
  it('scans a non-vacuous set of web files and names at least one rule', () => {
    expect(webFiles.length).toBeGreaterThan(100);
    expect(RULE_NAMES.length).toBeGreaterThan(0);
  });

  describe.each(RULE_NAMES)('%s', (name) => {
    it('is exported by the shared package as a function', () => {
      expect(typeof (projectRequests as Record<string, unknown>)[name]).toBe('function');
    });

    it('is declared by no apps/web file', () => {
      const declarers = webFiles.filter((f) => declaresName(f.code, name)).map((f) => f.rel);
      expect(declarers).toEqual([]);
    });

    it('is imported from the shared home by every apps/web file that names it', () => {
      const users = webFiles.filter((f) => f.code.includes(name));
      expect(users.length).toBeGreaterThan(0);
      const missing = users
        .filter((f) => !namedImportsFrom(f.code, SHARED_HOME).includes(name))
        .map((f) => f.rel);
      expect(missing).toEqual([]);
    });
  });
});
