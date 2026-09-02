import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { requestSharedFiles, requestFileGrants } from './request-files';

/**
 * BAL-431 / ADR-1048 — the ON DELETE behaviour of every foreign key on the two request-file
 * tables.
 *
 * ⚠ WHY THIS IS A TEST AND NOT A COMMENT. Each rule below is a one-word argument in a
 * `.references()` call, and getting one wrong is silent: typecheck, lint and every mocked unit
 * test pass either way, and the damage only appears when a row is actually deleted in
 * production. The two rules are opposites and are easy to transpose:
 *
 *   • CASCADE on the ANCHORS (the request, the file, the relationship) — a shared file and its
 *     grants must not outlive the request they belong to. RESTRICT here would make deleting a
 *     request impossible.
 *   • RESTRICT on the ATTRIBUTION columns (uploader, deleter, granter, revoker) — ADR-1030's
 *     rule, and Ruling 3/4's audit requirement. CASCADE here would erase the audit trail as a
 *     side effect of a user deletion: the file row would vanish, or the "who removed it" answer
 *     would silently become NULL, precisely when it is most needed.
 *
 * Reading the LIVE table metadata (rather than the migration SQL) means a hand-edit to either
 * the schema or a regenerated migration is caught, and the assertions are structural — no
 * comment can satisfy them.
 */

type FkRule = { column: string; table: string; onDelete: string };

function fkRules(table: Parameters<typeof getTableConfig>[0]): FkRule[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => {
      const ref = fk.reference();
      const [column] = ref.columns;
      if (column === undefined) throw new Error('foreign key with no column');
      return {
        column: column.name,
        table: getTableName(ref.foreignTable),
        onDelete: fk.onDelete ?? 'no action',
      };
    })
    .sort((a, b) => a.column.localeCompare(b.column));
}

describe('request_shared_files foreign keys', () => {
  const rules = fkRules(requestSharedFiles);

  it.each([
    // ANCHOR — a shared file cannot outlive its request.
    ['project_request_id', 'project_requests', 'cascade'],
    // ATTRIBUTION — the uploader must survive their own departure (ADR-1030).
    ['uploaded_by_user_id', 'users', 'restrict'],
    // RULING 3 — who removed it. Attribution survives.
    ['deleted_by_user_id', 'users', 'restrict'],
  ])('%s references %s ON DELETE %s', (column, table, onDelete) => {
    const rule = rules.find((r) => r.column === column);
    expect(rule).toBeDefined();
    expect(rule?.table).toBe(table);
    expect(rule?.onDelete).toBe(onDelete);
  });

  /** No attribution column may ever be CASCADE — that would delete the audit trail. */
  it('never cascades from a user', () => {
    for (const rule of rules.filter((r) => r.table === 'users')) {
      expect(rule.onDelete).toBe('restrict');
    }
  });
});

describe('request_file_grants foreign keys', () => {
  const rules = fkRules(requestFileGrants);

  it.each([
    // ANCHORS — a grant is meaningless without its file, its track, or its request.
    ['file_id', 'request_shared_files', 'cascade'],
    ['relationship_id', 'request_expert_relationships', 'cascade'],
    ['project_request_id', 'project_requests', 'cascade'],
    // ATTRIBUTION — who opened, and who closed, this access boundary.
    ['granted_by_user_id', 'users', 'restrict'],
    ['revoked_by_user_id', 'users', 'restrict'],
  ])('%s references %s ON DELETE %s', (column, table, onDelete) => {
    const rule = rules.find((r) => r.column === column);
    expect(rule).toBeDefined();
    expect(rule?.table).toBe(table);
    expect(rule?.onDelete).toBe(onDelete);
  });

  it('never cascades from a user', () => {
    for (const rule of rules.filter((r) => r.table === 'users')) {
      expect(rule.onDelete).toBe('restrict');
    }
  });

  /**
   * ⚠ THE DENORMALISED ANCHOR IS LOAD-BEARING. `project_request_id` is duplicated onto the
   * grant so the composite backstops can pin a grant to the same request as its file; dropping
   * it (as "redundant") removes the only structural guard against a grant pointing at a track
   * on a DIFFERENT request.
   */
  it('keeps the denormalised request anchor that the composite backstops pin to', () => {
    expect(rules.map((r) => r.column)).toContain('project_request_id');
  });
});
