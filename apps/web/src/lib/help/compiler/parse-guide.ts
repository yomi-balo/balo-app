import { Lexer, Parser, type Token, type Tokens } from 'marked';
import { parse as parseYaml } from 'yaml';
import type { HelpBlock, HelpBlockContent, HelpImageRef, HelpSection } from '../types';
import { isKebab } from './kebab';
import { sanitizeHelpHtml } from './sanitize-help-html';
import type { HelpDocIssue } from './types';

export interface ParsedHelpDoc {
  /** The filename stem. */
  readonly slug: string;
  /** The parsed YAML value, or `undefined` when the file has no frontmatter block. */
  readonly frontmatter: unknown;
  readonly intro: readonly HelpBlock<HelpImageRef>[];
  readonly sections: readonly HelpSection<HelpImageRef>[];
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

// `&amp;` is last on purpose: decoding it first would turn `&amp;lt;` into `<` instead of `&lt;`.
const ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
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

/** Calls `visit` on every token at any depth: list items, quotes, table cells and inline tokens. */
function visitTokens(tokens: readonly Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    const generic = token as Tokens.Generic;
    const nested: Token[] = [
      ...(Array.isArray(generic.tokens) ? generic.tokens : []),
      ...(Array.isArray(generic.items) ? generic.items : []),
      ...(Array.isArray(generic.header) ? generic.header : []),
      ...(Array.isArray(generic.rows) ? generic.rows.flat() : []),
    ];
    visitTokens(nested, visit);
  }
}

function containsImage(tokens: readonly Token[]): boolean {
  let found = false;
  visitTokens(tokens, (token) => {
    if (token.type === 'image') found = true;
  });
  return found;
}

/** Names the markdown constructs the guide renderer does not support, once each. */
function unsupportedLabels(tokens: readonly Token[]): Set<string> {
  const labels = new Set<string>();
  visitTokens(tokens, (token) => {
    if (
      token.type === 'table' ||
      token.type === 'code' ||
      token.type === 'hr' ||
      token.type === 'html'
    ) {
      labels.add(token.type);
    } else if (token.type === 'heading' && token.depth >= 5) {
      labels.add(`heading level ${token.depth}`);
    }
  });
  return labels;
}

function isBlankInline(token: Token): boolean {
  return token.type === 'br' || (token.type === 'text' && token.raw.trim() === '');
}

function renderHtml(tokens: readonly Token[]): string {
  return sanitizeHelpHtml(Parser.parse([...tokens])).trim();
}

class DocWalker {
  readonly issues: HelpDocIssue[] = [];
  readonly intro: HelpBlock<HelpImageRef>[] = [];
  readonly sections: {
    n: number;
    title: string;
    blocks: HelpBlock<HelpImageRef>[];
    screenshot: HelpImageRef | null;
  }[] = [];
  private pending: Token[] = [];

  constructor(
    private readonly file: string,
    private readonly slug: string
  ) {}

  private report(code: HelpDocIssue['code'], message: string): void {
    this.issues.push({ file: this.file, code, message });
  }

  private pushBlock(content: HelpBlockContent<HelpImageRef>): void {
    const section = this.sections.at(-1);
    const blocks = section?.blocks ?? this.intro;
    const prefix = section === undefined ? 'intro' : `s${section.n}`;
    blocks.push({ ...content, id: `${prefix}-b${blocks.length}` });
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const html = renderHtml(this.pending);
    this.pending = [];
    if (html !== '') this.pushBlock({ kind: 'html', html });
  }

  private toImage(token: Tokens.Image): HelpImageRef | null {
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

  private addImage(image: HelpImageRef): void {
    const section = this.sections.at(-1);
    if (section?.screenshot === null) {
      section.screenshot = image;
      return;
    }
    this.pushBlock({ kind: 'image', image });
  }

  private rejectUnsupported(token: Token): void {
    for (const label of unsupportedLabels([token])) {
      this.report(
        'unsupported_markdown',
        `Unsupported markdown (${label}); the guide renderer cannot show it.`
      );
    }
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

  private handleBlockquote(token: Tokens.Blockquote): void {
    this.flush();
    this.rejectNestedImages(token.tokens);
    const html = renderHtml(token.tokens);
    if (html !== '') this.pushBlock({ kind: 'callout', html });
  }

  private handleToken(token: Token): void {
    if (token.type === 'heading' && token.depth === 1) {
      this.report(
        'h1_in_body',
        'The title comes from frontmatter; remove the leading "# " heading.'
      );
      return;
    }
    if (token.type === 'heading' && token.depth === 2) {
      this.flush();
      this.sections.push({
        n: this.sections.length + 1,
        title: plainText(token.tokens ?? []),
        blocks: [],
        screenshot: null,
      });
      return;
    }
    if (token.type === 'blockquote') {
      this.handleBlockquote(token as Tokens.Blockquote);
      return;
    }
    if (token.type === 'paragraph') {
      if (!this.handleParagraph(token as Tokens.Paragraph)) this.pending.push(token);
      return;
    }
    this.rejectNestedImages([token]);
    this.pending.push(token);
  }

  walk(tokens: readonly Token[]): void {
    for (const token of tokens) {
      if (token.type === 'space') continue;
      this.rejectUnsupported(token);
      this.handleToken(token);
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
