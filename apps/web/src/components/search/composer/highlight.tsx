import { type ReactNode } from 'react';

/**
 * Wrap the first case-insensitive match of `query` in `text` with a semantic
 * highlight mark. Returns the plain text when there is no query or no match.
 */
export function highlightMatch(text: string, query: string): ReactNode {
  if (query === '') return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-primary/15 text-primary rounded-[2px]">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}
