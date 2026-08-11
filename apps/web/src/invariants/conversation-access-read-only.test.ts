import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { codeLinesOf } from './_source-scan';
import {
  CONVERSATION_ACCESS_MODULE,
  READ_ONLY_ACCESS_RESOLVER,
  READ_ONLY_ALLOWLIST,
  WRITING_ACCESS_RESOLVER,
} from './_read-only-actions';

/**
 * BAL-424 — THE TRANSITIVE-WRITE INVARIANT.
 *
 * `onboarding-mutation-gate.test.ts` allows a handful of Server Actions to authenticate with
 * bare `requireUser()` because they are pure reads. That check inspects each action's OWN
 * SOURCE, so it is blind to a write reached through an import — and `resolveConversationAccess`
 * get-or-CREATES the thread it names. The moment an allowlisted action calls it, an
 * un-onboarded member can insert rows while both the allowlist justification and the gate test
 * stay green.
 *
 * ⚠⚠ THE SUBJECT LIST IS DERIVED FROM `READ_ONLY_ALLOWLIST`, NEVER HAND-MAINTAINED. An earlier
 * version of this file listed its two subjects literally and MISSED THE THIRD
 * (`get-proposal-document-download.ts`), which kept the writing variant with both invariants
 * passing. Deriving it means a new allowlist entry is enrolled automatically.
 */

/**
 * CI runs web vitest from the REPO ROOT while a developer may run it from `apps/web`, so a
 * single cwd-relative path resolves to nothing in one of the two — and a scan that finds
 * nothing passes every assertion for the wrong reason (memory
 * `reference_web_server_disk_asset_cwd`). The `resolvedFiles` test below turns an unresolved
 * directory into a loud failure rather than a vacuous pass.
 */
function resolveSrcDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'src'),
    path.resolve(process.cwd(), 'apps', 'web', 'src'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'invariants'))) ?? '';
}

const SRC_DIR = resolveSrcDir();

interface AllowlistedAction {
  readonly rel: string;
  /** Comment lines stripped, so a docblock naming the writing variant is not a false positive. */
  readonly code: string;
}

/** Every allowlisted action that exists on disk, with its comment-free source. */
const ACTIONS: AllowlistedAction[] =
  SRC_DIR === ''
    ? []
    : READ_ONLY_ALLOWLIST.filter((rel) => existsSync(path.join(SRC_DIR, rel))).map((rel) => ({
        rel,
        code: codeLinesOf(readFileSync(path.join(SRC_DIR, rel), 'utf8')),
      }));

/** The subset that resolves conversation access at all — the ones this invariant governs. */
const CONVERSATION_ACTIONS = ACTIONS.filter((a) => a.code.includes(CONVERSATION_ACCESS_MODULE));

describe('read-only Server Actions never reach the writing access resolver', () => {
  /**
   * GUARDS THE GUARD. Without this, a bad `SRC_DIR`, a renamed action, or a changed module
   * path would empty the subject list and every assertion below would pass vacuously.
   */
  it('resolves every allowlisted action on disk, and finds the conversation ones', () => {
    expect(SRC_DIR).not.toBe('');
    expect(ACTIONS.map((a) => a.rel)).toEqual([...READ_ONLY_ALLOWLIST]);
    // All three of today's allowlist entries resolve conversation access.
    expect(CONVERSATION_ACTIONS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(CONVERSATION_ACTIONS.map((a) => a.rel))(
    '%s uses the read-only access resolver',
    (rel) => {
      const action = CONVERSATION_ACTIONS.find((a) => a.rel === rel);
      expect(action).toBeDefined();
      expect(action?.code).toContain(READ_ONLY_ACCESS_RESOLVER);
    }
  );

  it.each(CONVERSATION_ACTIONS.map((a) => a.rel))(
    '%s never calls the get-or-create variant',
    (rel) => {
      const action = CONVERSATION_ACTIONS.find((a) => a.rel === rel);
      expect(action).toBeDefined();
      // Prefix-free names, so a plain `includes` cannot confuse the two in either direction.
      expect(action?.code).not.toContain(WRITING_ACCESS_RESOLVER);
    }
  );
});

describe('the writing resolver is the only one that provisions', () => {
  const code = codeLinesOf(
    readFileSync(path.join(SRC_DIR, 'lib/project-request/resolve-conversation-access.ts'), 'utf8')
  );

  it('exports both variants', () => {
    expect(code).toContain(`export async function ${WRITING_ACCESS_RESOLVER}`);
    expect(code).toContain(`export async function ${READ_ONLY_ACCESS_RESOLVER}`);
  });

  it('calls ensureForContext exactly once, and findByContext exactly once', () => {
    expect(code.match(/ensureForContext/g)).toHaveLength(1);
    expect(code.match(/findByContext/g)).toHaveLength(1);
  });

  /**
   * Both variants must run the SAME checks in the SAME order. Sharing one core is what
   * guarantees that; two hand-maintained copies would drift, and a drifted read path is an
   * IDOR.
   */
  it('shares one authorization core rather than duplicating the checks', () => {
    expect(code.match(/async function authorizeThread/g)).toHaveLength(1);
    expect(code.match(/await authorizeThread\(/g)).toHaveLength(2);
    // Neither variant re-implements the lens/status guards.
    expect(code.match(/resolveRequestLens\(/g)).toHaveLength(1);
    expect(code.match(/isThreadOpenStatus\(/g)).toHaveLength(1);
  });
});
