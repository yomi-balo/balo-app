import { HELP_AUDIENCES } from '@balo/analytics/events';
import { EXPERT_MONEY_TERMS, FEE_TERMS, forbiddenTermsIn } from '@/lib/copy/forbidden-terms';
import { isHelpCategoryId } from '../categories';
import type { HelpBlock, HelpImageRef, HelpSection } from '../types';
import { helpFrontmatterSchema, type HelpFrontmatter } from './frontmatter-schema';
import { isKebab } from './kebab';
import { parseHelpDoc } from './parse-guide';
import type { HelpDocIssue, HelpSourceFile } from './types';

function stemOf(filename: string): string {
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Audience values in the raw frontmatter that are not a known side. */
function unknownAudiences(frontmatter: unknown): string[] {
  if (!isRecord(frontmatter) || !Array.isArray(frontmatter.audience)) return [];
  const known: readonly unknown[] = HELP_AUDIENCES;
  return frontmatter.audience.filter((value) => !known.includes(value)).map(String);
}

function crossFieldIssues(
  file: string,
  stem: string,
  fm: HelpFrontmatter,
  stems: ReadonlySet<string>
): HelpDocIssue[] {
  const issues: HelpDocIssue[] = [];
  const report = (code: HelpDocIssue['code'], message: string): void => {
    issues.push({ file, code, message });
  };

  if (fm.slug !== undefined && fm.slug !== stem) {
    report('slug_mismatch', `Frontmatter slug "${fm.slug}" does not match the filename "${stem}".`);
  }

  const categorySides = HELP_AUDIENCES.filter((side) => fm.category[side] !== undefined);
  const sameSides =
    categorySides.length === fm.audience.length &&
    categorySides.every((side) => fm.audience.includes(side));
  if (!sameSides) {
    report(
      'category_audience_mismatch',
      `category keys [${categorySides.join(', ')}] must equal audience [${fm.audience.join(', ')}].`
    );
  }

  for (const side of categorySides) {
    const id = fm.category[side];
    if (id !== undefined && !isHelpCategoryId(side, id)) {
      report('unknown_category', `"${id}" is not a ${side} category.`);
    }
  }

  for (const slug of fm.related) {
    if (!stems.has(slug)) report('unknown_related', `Related guide "${slug}" does not exist.`);
  }
  return issues;
}

function missingImageIssues(
  file: string,
  images: readonly HelpImageRef[],
  imageExists: (publicPath: string) => boolean
): HelpDocIssue[] {
  return images.flatMap((image) =>
    [image.lightSrc, image.darkSrc]
      .filter((src) => !imageExists(src))
      .map((src) => ({
        file,
        code: 'missing_image' as const,
        message: `Image file ${src} is missing.`,
      }))
  );
}

function textOf(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function forbiddenCopyIssues(
  file: string,
  fm: HelpFrontmatter,
  parsed: ReturnType<typeof parseHelpDoc>
): HelpDocIssue[] {
  const blocks = [...parsed.intro, ...parsed.sections.flatMap((section) => section.blocks)];
  const text = [
    fm.title,
    fm.summary,
    ...parsed.sections.map((section) => section.title),
    ...blocks.map((block) => (block.kind === 'image' ? block.image.alt : textOf(block.html))),
  ].join('\n');
  const banned: readonly string[] = fm.audience.includes('client')
    ? [...FEE_TERMS, ...EXPERT_MONEY_TERMS]
    : FEE_TERMS;
  return forbiddenTermsIn(text, banned).map((term) => ({
    file,
    code: 'forbidden_copy' as const,
    message: `The copy mentions "${term}", which guides must not use.`,
  }));
}

const HELP_LINK = /href="\/help\/([^"#?/]+)/g;

/** A published guide may only link to guides that are published too; anything else is a 404. */
function unpublishedLinkIssues(
  file: string,
  blocks: readonly HelpBlock<HelpImageRef>[],
  publishedStems: ReadonlySet<string>
): HelpDocIssue[] {
  const slugs = blocks.flatMap((block) =>
    block.kind === 'image' ? [] : [...block.html.matchAll(HELP_LINK)].map((match) => match[1] ?? '')
  );
  return [...new Set(slugs)]
    .filter((slug) => !publishedStems.has(slug))
    .map((slug) => ({
      file,
      code: 'unpublished_link' as const,
      message: `The link to /help/${slug} goes nowhere: that guide is not published.`,
    }));
}

const SUPPORT_SECTION_TITLE = /^(questions|need help|still stuck|contact us|get in touch)\??$/i;

/**
 * The guide page renders its own support block after the last section, so a guide never closes
 * with a sign-off section of its own. A support address inside a step, for a specific action, is
 * fine.
 */
function supportSectionIssues(
  file: string,
  sections: readonly HelpSection<HelpImageRef>[]
): HelpDocIssue[] {
  return sections
    .filter((section) => SUPPORT_SECTION_TITLE.test(section.title.trim()))
    .map((section) => ({
      file,
      code: 'support_section' as const,
      message: `Section "${section.title}" repeats the support block the guide page already shows.`,
    }));
}

function validateOne(
  { filename, source }: HelpSourceFile,
  stems: ReadonlySet<string>,
  publishedStems: ReadonlySet<string>,
  imageExists: (publicPath: string) => boolean
): HelpDocIssue[] {
  const stem = stemOf(filename);
  const parsed = parseHelpDoc(filename, source);
  const issues: HelpDocIssue[] = [...parsed.issues];

  if (!isKebab(stem)) {
    issues.push({
      file: filename,
      code: 'invalid_slug',
      message: `Filename "${stem}" must be lower-case kebab-case.`,
    });
  }
  if (parsed.frontmatter === undefined) return issues;

  const badAudiences = unknownAudiences(parsed.frontmatter);
  if (badAudiences.length > 0) {
    issues.push({
      file: filename,
      code: 'unknown_audience',
      message: `Unknown audience: ${badAudiences.join(', ')}. Use ${HELP_AUDIENCES.join(' or ')}.`,
    });
  }

  const result = helpFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!result.success) {
    const relevant = result.error.issues.filter(
      (issue) =>
        badAudiences.length === 0 || (issue.path[0] !== 'audience' && issue.path[0] !== 'category')
    );
    if (relevant.length > 0) {
      issues.push({
        file: filename,
        code: 'invalid_frontmatter',
        message: relevant
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      });
    }
    return issues;
  }

  const blocks = [...parsed.intro, ...parsed.sections.flatMap((section) => section.blocks)];
  issues.push(
    ...crossFieldIssues(filename, stem, result.data, stems),
    ...forbiddenCopyIssues(filename, result.data, parsed),
    ...supportSectionIssues(filename, parsed.sections)
  );
  if (result.data.published) {
    const images = blocks.flatMap((block) => (block.kind === 'image' ? [block.image] : []));
    const screenshots = parsed.sections.flatMap((section) =>
      section.screenshot === null ? [] : [section.screenshot]
    );
    issues.push(
      ...missingImageIssues(filename, [...screenshots, ...images], imageExists),
      ...unpublishedLinkIssues(filename, blocks, publishedStems)
    );
  }
  return issues;
}

/**
 * Every problem in a set of help docs. `imageExists` is asked about public paths such as
 * `/help/<slug>/<base>-light.png`. Missing images and links to unpublished guides are only
 * reported for published guides.
 */
export function validateHelpDocs(
  files: readonly HelpSourceFile[],
  imageExists: (publicPath: string) => boolean
): readonly HelpDocIssue[] {
  const stems = new Set(files.map((file) => stemOf(file.filename)));
  const publishedStems = new Set(
    files
      .filter(
        (file) =>
          helpFrontmatterSchema.safeParse(parseHelpDoc(file.filename, file.source).frontmatter).data
            ?.published === true
      )
      .map((file) => stemOf(file.filename))
  );
  return files.flatMap((file) => validateOne(file, stems, publishedStems, imageExists));
}
