import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { HelpFixtureState } from '../../packages/db/src/help-seed/constants';
import { test } from '../fixtures/auth';
import { captureSection } from './capture';
import { paddedSection, type Box, type HelpScheme } from './ring';

export type HelpPersona = 'expert' | 'client' | 'visitor';

export interface HelpSectionSpec {
  /** The guide's `##` ordinal. Equals the badge number and the `<nn>` in the filename. */
  section: number;
  as: HelpPersona;
  /** Fixture state, applied via `help:state` before navigation so tests stay order-independent. */
  state: HelpFixtureState;
  route: string | ((anchor: string) => string);
  setup?: (page: Page) => Promise<void>;
  target: (page: Page) => Locator;
  /** Omitted: the target box plus `cropPadding`. */
  crop?: (page: Page) => Locator;
  /**
   * Computes the crop box (viewport coords) from the page and the target's box, for crops a single
   * locator cannot express (for example one card's width but only part of its height).
   * Takes precedence over `crop`.
   */
  cropArea?: (page: Page, targetBox: Box) => Promise<Box>;
  /** CSS px around the crop box. Default 32. */
  cropPadding?: number;
  /** Ring radius in CSS px. Default: the target's computed border-radius. */
  radius?: number;
}

const DOCS_DIR = path.resolve(__dirname, '../../docs/help');
const IMAGE_REF = /!\[[^\]]*\]\((\d{2})\)/;
const IMAGE_REF_GLOBAL = new RegExp(IMAGE_REF, 'g');
const SCHEMES: readonly HelpScheme[] = ['light', 'dark'];

/** Removes fenced code blocks (``` or ~~~) so a `##` or image ref inside one is ignored. */
function stripFences(markdown: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker === undefined) {
        kept.push(line);
      } else {
        fence = marker;
      }
    } else if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = undefined;
    }
  }
  return kept.join('\n');
}

/** The text before the first `##` and the markdown body of each `##` section, in order. */
function readDoc(slug: string): { intro: string; sections: string[] } {
  const markdown = readFileSync(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
  const [intro = '', ...sections] = stripFences(markdown).split(/^## /m);
  return { intro, sections };
}

function assertSpecMatchesDoc(slug: string, sections: readonly HelpSectionSpec[]): void {
  const { intro, sections: bodies } = readDoc(slug);
  if (IMAGE_REF.test(intro)) {
    throw new Error(`${slug}: image ref ](nn) appears before the first ## section`);
  }
  const seen = new Set<number>();
  const specified = new Set(sections.map((spec) => paddedSection(spec.section)));
  bodies.forEach((body, index) => {
    for (const [, ref] of body.matchAll(IMAGE_REF_GLOBAL)) {
      if (ref === undefined) {
        continue;
      }
      if (!specified.has(ref)) {
        throw new Error(
          `${slug}: docs/help/${slug}.md references image ](${ref}) with no spec section`
        );
      }
      if (ref !== paddedSection(index + 1)) {
        throw new Error(
          `${slug}: image ref ](${ref}) appears in section ${index + 1}, not section ${Number(ref)}`
        );
      }
    }
  });
  for (const { section } of sections) {
    if (seen.has(section)) {
      throw new Error(`${slug}: duplicate section ${section}`);
    }
    seen.add(section);
    const body = bodies[section - 1];
    if (!Number.isInteger(section) || body === undefined) {
      throw new Error(`${slug}: section ${section} is out of range (${bodies.length} sections)`);
    }
    if (!body.includes(`](${paddedSection(section)})`)) {
      throw new Error(
        `${slug}: section ${section} of docs/help/${slug}.md has no image ref ](${paddedSection(section)})`
      );
    }
  }
}

/**
 * Registers one test per section, run once per project (light, dark). Throws at load time if the
 * spec and `docs/help/<slug>.md` disagree, so they cannot drift.
 */
export function defineGuide(slug: string, sections: readonly HelpSectionSpec[]): void {
  assertSpecMatchesDoc(slug, sections);
  for (const spec of sections) {
    test(`${slug} ${paddedSection(spec.section)}`, async ({ page, seedSession }, testInfo) => {
      const scheme = SCHEMES.find((name) => name === testInfo.project.name);
      if (scheme === undefined) {
        throw new Error(`Unknown help-screenshot project "${testInfo.project.name}"`);
      }
      await captureSection({
        page,
        seedSession,
        slug,
        spec,
        scheme,
        projectUse: testInfo.project.use,
      });
    });
  }
}
