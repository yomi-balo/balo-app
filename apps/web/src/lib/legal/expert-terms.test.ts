import { describe, expect, it } from 'vitest';
import { DEFAULT_BALO_FEE_BPS, formatFeePercent } from '@balo/shared/pricing';
import { PLATFORM_PRICING } from '@/lib/constants/platform';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import {
  EXPERT_TERMS,
  EXPERT_TERMS_LAST_UPDATED,
  EXPERT_TERMS_LAST_UPDATED_LABEL,
  EXPERT_TERMS_PREAMBLE,
  CLAUSE_TOKEN,
  buildClauseIndex,
  clauseLabel,
  resolveClauseRefs,
  type TermsNode,
} from './expert-terms';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const INDEX = buildClauseIndex(EXPERT_TERMS);

/** Every value `pick` returns for a clause and its descendants, depth first. */
function collectFromNodes<T>(
  nodes: readonly TermsNode[],
  pick: (node: TermsNode) => readonly T[]
): T[] {
  return nodes.flatMap((node) => [...pick(node), ...collectFromNodes(node.children ?? [], pick)]);
}

const RAW_TEXT: string[] = [
  ...EXPERT_TERMS_PREAMBLE,
  ...EXPERT_TERMS.flatMap((section) => [
    section.title,
    ...collectFromNodes(section.clauses, (node) => [
      node.text,
      ...(node.after === undefined ? [] : [node.after]),
    ]),
  ]),
];
const ALL_TEXT = RAW_TEXT.map((text) => resolveClauseRefs(text, INDEX)).join('\n');

describe('expert terms — fee figures are derived, never typed', () => {
  it('has no literal percentage in the module code', () => {
    const dir = resolveRouteDir(['src/lib/legal', 'apps/web/src/lib/legal']);
    expect(dir).not.toBe('');
    const code = codeLinesOf(readFileSync(path.join(dir, 'expert-terms.ts'), 'utf8'));
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/\d\s*%/);
  });

  it('states both the fee on top of the Rate and its share of the price the User pays', () => {
    expect(ALL_TEXT).toContain(
      `${formatFeePercent(DEFAULT_BALO_FEE_BPS)} of your Rate, which is ${PLATFORM_PRICING.SERVICE_FEE_SHARE_LABEL} of the price the User pays`
    );
  });
});

describe('expert terms — vendor and pricing language', () => {
  it('does not name Stripe, hourly rates or credits per minute, and names Airwallex', () => {
    expect(ALL_TEXT).not.toMatch(/stripe/i);
    expect(ALL_TEXT).not.toMatch(/hourly/i);
    expect(ALL_TEXT).not.toMatch(/credits per minute/i);
    expect(ALL_TEXT).toContain('Airwallex');
  });
});

describe('expert terms — clause references', () => {
  it('resolves every token and leaves none behind', () => {
    const tokens = RAW_TEXT.flatMap((text) => [...text.matchAll(CLAUSE_TOKEN)].map((m) => m[1]));
    expect(tokens.length).toBeGreaterThan(10);
    const known = [...INDEX.keys()];
    for (const id of tokens) {
      expect(known).toContain(id);
    }
    expect(ALL_TEXT).not.toContain('{{');
  });

  it('keeps ids unique across sections and clauses', () => {
    const ids = [
      ...EXPERT_TERMS.map((section) => section.id),
      ...EXPERT_TERMS.flatMap((section) =>
        collectFromNodes(section.clauses, (node) => (node.id === undefined ? [] : [node.id]))
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('throws on an unknown id', () => {
    expect(() => resolveClauseRefs('{{clause:nope}}', INDEX)).toThrow('nope');
  });

  it('leaves text without tokens unchanged', () => {
    expect(resolveClauseRefs('no tokens here', INDEX)).toBe('no tokens here');
  });

  it('resolves the renumbered targets', () => {
    expect(INDEX.get('marketplace.off-platform')).toBe('3.15');
    expect(INDEX.get('recording')).toBe('12');
    expect(INDEX.get('confidentiality')).toBe('11');
    expect(INDEX.get('disputes')).toBe('24');
    expect(INDEX.get('inappropriate-use.unlawful-content')).toBe('14.6');
    expect(INDEX.get('multiple-providers')).toBe('17');
    expect(INDEX.get('multiple-providers.warranties')).toBe('17.2');
    expect(INDEX.get('fees.service-fee')).toBe('8.2');
    expect(INDEX.get('fees.gst')).toBe('8.9');
    expect(INDEX.get('fees.payout-schedule')).toBe('8.8.3');
    expect(INDEX.get('services.licence')).toBe('4.3');
    expect(INDEX.get('cancellation.without-cause')).toBe('10.5');
  });

  it('has 25 sections with Recording at 12', () => {
    expect(EXPERT_TERMS).toHaveLength(25);
    expect(EXPERT_TERMS[11]?.title).toBe('Recording, Transcription and AI');
  });
});

describe('expert terms — draft markers', () => {
  it('flags exactly the drafted clauses', () => {
    const ids = EXPERT_TERMS.flatMap((section) => [
      ...(section.draft ? [section.id] : []),
      ...collectFromNodes(section.clauses, (node) =>
        node.draft && node.id !== undefined ? [node.id] : []
      ),
    ]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(
      new Set(['marketplace.payout-eligibility', 'fees', 'payment-by-user', 'recording'])
    );
  });
});

describe('expert terms — text hygiene', () => {
  it('uses straight quotes only', () => {
    for (const char of ['ʼ', '‘', '’', '“', '”', 'ˮ']) {
      expect(ALL_TEXT).not.toContain(char);
    }
  });

  it('has no double spaces or doubled full stops', () => {
    expect(ALL_TEXT).not.toContain('  ');
    expect(ALL_TEXT).not.toContain('..');
  });

  it('is gender-neutral', () => {
    expect(ALL_TEXT).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });

  it('has none of the source typos', () => {
    for (const typo of [
      /you are will\b/,
      /free from of\b/,
      /means means/,
      /strictly confidentially/,
    ]) {
      expect(ALL_TEXT).not.toMatch(typo);
    }
  });

  it('opens the parenthesis in the GST Law definition', () => {
    expect(ALL_TEXT).toContain('A New Tax System (Goods and Services Tax) Act 1999');
  });
});

describe('clauseLabel', () => {
  it.each([
    [[3], '3'],
    [[3, 7], '3.7'],
    [[3, 7, 1], '3.7.1'],
    [[6, 3, 1, 1], '(a)'],
    [[6, 3, 1, 3], '(c)'],
    [[23, 2, 4, 1, 1], 'i.'],
    [[23, 2, 4, 1, 2], 'ii.'],
  ])('labels %j as %s', (position, label) => {
    expect(clauseLabel(position)).toBe(label);
  });

  it('rejects an empty, too deep, or out-of-range path', () => {
    expect(() => clauseLabel([])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 1, 1, 1])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 1, 99])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 27])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 0])).toThrow(RangeError);
  });
});

describe('last updated', () => {
  it('exposes the ISO date and its long label', () => {
    expect(EXPERT_TERMS_LAST_UPDATED).toBe('2026-10-12');
    expect(EXPERT_TERMS_LAST_UPDATED_LABEL).toBe('12 October 2026');
  });
});
