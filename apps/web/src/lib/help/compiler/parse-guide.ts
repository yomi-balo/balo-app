import { Lexer, Parser, type Token, type Tokens } from 'marked';
import { parse as parseYaml } from 'yaml';
import type { HelpBlock, HelpImage, HelpSection } from '../types';
import { isKebab } from './kebab';
import { sanitizeHelpHtml } from './sanitize-help-html';
import type { HelpDocIssue } from './types';

export interface ParsedHelpDoc {
  /** The filename stem. */
  readonly slug: string;
  /** The parsed YAML value, or `undefined` when the file has no frontmatter block. */
  readonly frontmatter: unknown;
  readonly intro: readonly HelpBlock[];
  readonly sections: readonly HelpSection[];
  readonly issues: readonly HelpDocIssue[];
}

const FENCE = '---';

interface SplitSource {
  readonly yamlText: string | null;
  readonly body: string;
}

/** Splits a leading `---` ... `---` block off the source. */
function splitFrontmatter(source: string): SplitSource {
  const text = source.replaceAll('\r\n', '\n');
  if (!text.startsWith(`${FENCE}\n`)) return { yamlText: null, body: text };
  const close = text.indexOf(`\n${FENCE}\n`, FENCE.length);
  if (close !== -1) {
    return {
      yamlText: text.slice(FENCE.length + 1, close),
      body: text.slice(close + FENCE.length + 2),
    };
  }
  if (text.endsWith(`\n${FENCE}`)) {
    return { yamlText: text.slice(FENCE.length + 1, -(FENCE.length + 1)), body: '' };
  }
  return { yamlText: null, body: text };
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.replaceAll(entity, char);
  return out;
}

/** The text of inline tokens with markup removed and entities decoded. */
function plainText(tokens: readonly Token[]): string {
  return decodeEntities(
    tokens
      .map((token) => {
        if ('tokens' in token && Array.isArray(token.tokens))
          return plainText(token.tokens as Token[]);
        return 'text' in token && typeof token.text === 'string' ? token.text : '';
      })
      .join('')
  ).trim();
}

/** Whether any token, at any depth (list items, quotes, table cells, inline), is an image. */
function containsImage(tokens: readonly Token[]): boolean {
  return tokens.some((token) => {
    if (token.type === 'image') return true;
    const generic = token as Tokens.Generic;
    const nested: Token[] = [
      ...(Array.isArray(generic.tokens) ? generic.tokens : []),
      ...(Array.isArray(generic.items) ? generic.items : []),
      ...(Array.isArray(generic.header) ? generic.header : []),
      ...(Array.isArray(generic.rows) ? generic.rows.flat() : []),
    ];
    return containsImage(nested);
  });
}

function isBlankInline(token: Token): boolean {
  return token.type === 'br' || (token.type === 'text' && token.raw.trim() === '');
}

function renderHtml(tokens: readonly Token[]): string {
  return sanitizeHelpHtml(Parser.parse([...tokens])).trim();
}

class DocWalker {
  readonly issues: HelpDocIssue[] = [];
  readonly intro: HelpBlock[] = [];
  readonly sections: {
    n: number;
    title: string;
    blocks: HelpBlock[];
    screenshot: HelpImage | null;
  }[] = [];
  private pending: Token[] = [];

  constructor(
    private readonly file: string,
    private readonly slug: string
  ) {}

  private report(code: HelpDocIssue['code'], message: string): void {
    this.issues.push({ file: this.file, code, message });
  }

  private target(): HelpBlock[] {
    return this.sections.at(-1)?.blocks ?? this.intro;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const html = renderHtml(this.pending);
    this.pending = [];
    if (html !== '') this.target().push({ kind: 'html', html });
  }

  private toImage(token: Tokens.Image): HelpImage | null {
    if (!isKebab(token.href)) {
      this.report(
        'invalid_image_ref',
        `Image "${token.href}" must be a bare kebab-case name such as "01-book-button".`
      );
      return null;
    }
    const base = `/help/${this.slug}/${token.href}`;
    return {
      alt: plainText([token]) || decodeEntities(token.text),
      lightSrc: `${base}-light.png`,
      darkSrc: `${base}-dark.png`,
    };
  }

  private addImage(image: HelpImage): void {
    const section = this.sections.at(-1);
    if (section !== undefined && section.screenshot === null) {
      section.screenshot = image;
      return;
    }
    this.target().push({ kind: 'image', image });
  }

  private rejectNestedImages(tokens: readonly Token[]): void {
    if (containsImage(tokens)) {
      this.report(
        'inline_image',
        'An image must sit on its own line, not inside a list, quote or table.'
      );
    }
  }

  private handleParagraph(token: Tokens.Paragraph): boolean {
    const images = token.tokens.filter((inline): inline is Tokens.Image => inline.type === 'image');
    if (images.length === 0) return false;
    if (token.tokens.some((inline) => inline.type !== 'image' && !isBlankInline(inline))) {
      this.report('inline_image', 'An image must sit on its own line, not inside a sentence.');
      return true;
    }
    this.flush();
    for (const image of images) {
      const resolved = this.toImage(image);
      if (resolved !== null) this.addImage(resolved);
    }
    return true;
  }

  walk(tokens: readonly Token[]): void {
    for (const token of tokens) {
      if (token.type === 'space') continue;
      if (token.type === 'heading' && token.depth === 1) {
        this.report(
          'h1_in_body',
          'The title comes from frontmatter; remove the leading "# " heading.'
        );
      } else if (token.type === 'heading' && token.depth === 2) {
        this.flush();
        this.sections.push({
          n: this.sections.length + 1,
          title: plainText(token.tokens ?? []),
          blocks: [],
          screenshot: null,
        });
      } else if (token.type === 'blockquote') {
        this.flush();
        this.rejectNestedImages(token.tokens ?? []);
        const html = renderHtml(token.tokens ?? []);
        if (html !== '') this.target().push({ kind: 'callout', html });
      } else if (token.type !== 'paragraph' || !this.handleParagraph(token as Tokens.Paragraph)) {
        if (token.type !== 'paragraph') this.rejectNestedImages([token]);
        this.pending.push(token);
      }
    }
    this.flush();
  }
}

/** Parses one `docs/help` markdown file into the guide model plus the issues found while reading it. */
export function parseHelpDoc(filename: string, source: string): ParsedHelpDoc {
  const slug = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  const { yamlText, body } = splitFrontmatter(source);
  const walker = new DocWalker(filename, slug);
  let frontmatter: unknown;

  if (yamlText === null) {
    walker.issues.push({
      file: filename,
      code: 'missing_frontmatter',
      message: 'The file must start with a "---" frontmatter block.',
    });
  } else {
    try {
      frontmatter = parseYaml(yamlText);
    } catch (error) {
      walker.issues.push({
        file: filename,
        code: 'invalid_frontmatter',
        message: `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  walker.walk(Lexer.lex(body));
  return {
    slug,
    frontmatter,
    intro: walker.intro,
    sections: walker.sections,
    issues: walker.issues,
  };
}
