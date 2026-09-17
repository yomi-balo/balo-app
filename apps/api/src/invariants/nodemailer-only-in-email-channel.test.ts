import { describe, expect, it } from 'vitest';
import { ALL_SOURCE_FILES, isCommentLine, readRaw } from './_source-scan.js';

/**
 * BAL-475 (ADR-1044 Ruling 4) — a second transport INSIDE the one email channel, never a
 * second dispatch path. `nodemailer` is imported as a VALUE in exactly one file:
 * `notifications/channels/email.adapter.ts`. Every other reference — the delivery module, the
 * message builder, tests — imports ONLY types (`import type { ... } from 'nodemailer'`),
 * which this scan explicitly ignores.
 *
 * ⚠ WALK-DERIVED SUBJECTS, NOT A PINNED LIST — same reasoning as the counterparty-address
 * invariant: a new file that value-imports `nodemailer` must be caught by EXISTING, not by
 * someone remembering to add it to a list.
 *
 * ⚠ F20 (fix round 1, R20/S6) — MATCHES ANY CODE LINE NAMING THE SPECIFIER, NOT ONLY A STATIC
 * `import … from`. The original matcher required the literal substring `from 'nodemailer`,
 * which a dynamic `await import('nodemailer')` or a re-export (`export { default } from
 * 'nodemailer'`) both evade — neither contains the word `from` immediately before the quoted
 * specifier in the shape the old matcher looked for `import('nodemailer')` has no `from` at
 * all. Matching on the bare quoted specifier `'nodemailer` instead covers `import(`,
 * `require(` and re-exports uniformly, while still exempting a `import type` / `export type`
 * line. ⚠ ALSO USES THE SHARED `isCommentLine` (fixed in `_source-scan.ts` for F10(d)): a
 * private copy here would have kept the old bug — classifying `/* *\/ import nodemailer from
 * 'nodemailer';` as a comment line in full — even after the shared helper was fixed.
 *
 * IF THIS TEST FAILS, THE REMEDY IS A DECISION: a second nodemailer transport site is either a
 * bug (revert it) or a deliberate widening of ADR-1044 Ruling 4 (amend it first).
 */

const EMAIL_ADAPTER_FILE = 'notifications/channels/email.adapter.ts';

/** A non-comment line naming the `nodemailer` specifier that is NOT a type-only import/export. */
function isValueImportLine(line: string): boolean {
  if (!line.includes("'nodemailer")) return false;
  const trimmed = line.trimStart();
  return !(trimmed.startsWith('import type') || trimmed.startsWith('export type'));
}

function valueImportsNodemailer(rel: string): boolean {
  const raw = readRaw(rel);
  return raw.split('\n').some((line) => !isCommentLine(line) && isValueImportLine(line));
}

describe('nodemailer is value-imported in exactly one file', () => {
  it('scans the full apps/api source surface (guards a vacuous pass)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(200);
    expect(ALL_SOURCE_FILES).toContain(EMAIL_ADAPTER_FILE);
  });

  it('the adapter file itself value-imports nodemailer (non-vacuity)', () => {
    const raw = readRaw(EMAIL_ADAPTER_FILE);
    expect(raw).toContain("from 'nodemailer'");
    expect(valueImportsNodemailer(EMAIL_ADAPTER_FILE)).toBe(true);
  });

  it('exactly one file value-imports nodemailer', () => {
    const offenders = ALL_SOURCE_FILES.filter((rel) => valueImportsNodemailer(rel));
    expect(offenders).toEqual([EMAIL_ADAPTER_FILE]);
  });
});

/**
 * F20 (fix round 1, S6, optional hardening) — a hand-rolled `CalendarInviteTransport` handed to
 * the exported `deliverCalendarInvite` would be a second send path this file cannot see by
 * construction (it only ever looks at IMPORT lines). This does not close that gap — it is
 * structurally unreachable from a source scan — but it DOES pin that the delivery function is
 * only ever CALLED from the one sanctioned site, which is the shape a second dispatch path
 * would actually take.
 */
describe('deliverCalendarInvite is called only from the email adapter', () => {
  function callsDeliverCalendarInvite(rel: string): boolean {
    const raw = readRaw(rel);
    return raw
      .split('\n')
      .some((line) => !isCommentLine(line) && line.includes('deliverCalendarInvite('));
  }

  it('scans the full apps/api source surface (guards a vacuous pass)', () => {
    expect(ALL_SOURCE_FILES).toContain(EMAIL_ADAPTER_FILE);
  });

  it('the adapter file itself calls deliverCalendarInvite (non-vacuity)', () => {
    expect(callsDeliverCalendarInvite(EMAIL_ADAPTER_FILE)).toBe(true);
  });

  it('exactly one file calls deliverCalendarInvite( — excluding its own definition and tests', () => {
    const callers = ALL_SOURCE_FILES.filter(
      (rel) =>
        rel !== 'notifications/channels/calendar-invite-delivery.ts' &&
        callsDeliverCalendarInvite(rel)
    );
    expect(callers).toEqual([EMAIL_ADAPTER_FILE]);
  });
});

describe('the matcher actually fires (positive controls)', () => {
  it('matches a default value import', () => {
    expect(isValueImportLine("import nodemailer from 'nodemailer';")).toBe(true);
  });

  it('matches a named value import', () => {
    expect(isValueImportLine("import nodemailer, { type Transporter } from 'nodemailer';")).toBe(
      true
    );
  });

  it('ignores a type-only import', () => {
    expect(isValueImportLine("import type { SendMailOptions } from 'nodemailer';")).toBe(false);
  });

  it('ignores a type-only re-export', () => {
    expect(isValueImportLine("export type { SendMailOptions } from 'nodemailer';")).toBe(false);
  });

  it('F20 — matches a dynamic import', () => {
    expect(isValueImportLine("const { default: nodemailer } = await import('nodemailer');")).toBe(
      true
    );
  });

  it('F20 — matches a value re-export', () => {
    expect(isValueImportLine("export { default } from 'nodemailer';")).toBe(true);
  });

  it('ignores a comment line, even one that WOULD otherwise match', () => {
    const raw = "// import nodemailer from 'nodemailer';\nconst x = 1;";
    const matched = raw.split('\n').some((line) => !isCommentLine(line) && isValueImportLine(line));
    expect(matched).toBe(false);
  });

  it('F20/F10(d) — a same-line block comment with the import AFTER its close is a CODE line, and matches', () => {
    const raw = "/* */ import nodemailer from 'nodemailer';";
    const matched = raw.split('\n').some((line) => !isCommentLine(line) && isValueImportLine(line));
    expect(matched).toBe(true);
  });

  it('a line with no nodemailer specifier at all does not match', () => {
    expect(isValueImportLine("import { render } from '@react-email/render';")).toBe(false);
  });
});
