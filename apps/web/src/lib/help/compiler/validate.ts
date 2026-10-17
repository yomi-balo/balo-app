import { HELP_AUDIENCES } from '@balo/analytics/events';
import { EXPERT_MONEY_TERMS, FEE_TERMS, forbiddenTermsIn } from '@/lib/copy/forbidden-terms';
import { isHelpCategoryId } from '../categories';
import type { HelpImage } from '../types';
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
  images: readonly HelpImage[],
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

function validateOne(
  { filename, source }: HelpSourceFile,
  stems: ReadonlySet<string>,
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

  issues.push(
    ...crossFieldIssues(filename, stem, result.data, stems),
    ...forbiddenCopyIssues(filename, result.data, parsed)
  );
  if (result.data.published) {
    const images = [
      ...parsed.intro,
      ...parsed.sections.flatMap((section) => section.blocks),
    ].flatMap((block) => (block.kind === 'image' ? [block.image] : []));
    const screenshots = parsed.sections.flatMap((section) =>
      section.screenshot === null ? [] : [section.screenshot]
    );
    issues.push(...missingImageIssues(filename, [...screenshots, ...images], imageExists));
  }
  return issues;
}

/**
 * Every problem in a set of help docs. `imageExists` is asked about public paths such as
 * `/help/<slug>/<base>-light.png`; missing images are only reported for published guides.
 */
export function validateHelpDocs(
  files: readonly HelpSourceFile[],
  imageExists: (publicPath: string) => boolean
): readonly HelpDocIssue[] {
  const stems = new Set(files.map((file) => stemOf(file.filename)));
  return files.flatMap((file) => validateOne(file, stems, imageExists));
}
