import type { HelpSourceFile } from './types';

interface FixtureOptions {
  readonly frontmatter?: Readonly<Record<string, string>>;
  readonly omit?: readonly string[];
  readonly body?: string;
}

const DEFAULT_FRONTMATTER: Readonly<Record<string, string>> = {
  title: '"Booking a consultation"',
  summary: '"Pick a time and confirm."',
  audience: '[client]',
  category: '{ client: calls }',
  order: '1',
  published: 'true',
  updated: '2026-10-17',
  related: '[]',
};

const DEFAULT_BODY = 'Intro paragraph.\n\n## First step\n\nDo the thing.\n';

/** A valid help doc, with any frontmatter field overridden or omitted, and a replaceable body. */
export function helpDoc(filename: string, options: FixtureOptions = {}): HelpSourceFile {
  const fields = { ...DEFAULT_FRONTMATTER, ...options.frontmatter };
  const lines = Object.entries(fields)
    .filter(([key]) => !(options.omit ?? []).includes(key))
    .map(([key, value]) => `${key}: ${value}`);
  return {
    filename,
    source: `---\n${lines.join('\n')}\n---\n\n${options.body ?? DEFAULT_BODY}`,
  };
}
