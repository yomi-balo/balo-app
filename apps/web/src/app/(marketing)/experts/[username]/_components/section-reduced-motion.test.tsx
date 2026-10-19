import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so each
 * section's server markup (the wrapper's inline `initial` style) must not depend on it.
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { AboutSection } from './about-section';
import { ExpertiseSection } from './expertise-section';
import { QuickStartsSection } from './quick-starts-section';
import { WorkSection } from './work-section';

const SECTIONS: ReadonlyArray<readonly [string, () => React.JSX.Element]> = [
  ['AboutSection', () => <AboutSection bio="Hello" firstName="Priya" />],
  ['ExpertiseSection', () => <ExpertiseSection competencies={[]} certifications={[]} />],
  ['WorkSection', () => <WorkSection workHistory={[]} firstName="Priya" />],
  [
    'QuickStartsSection',
    () => <QuickStartsSection packages={[]} firstName="Priya" onStartProject={vi.fn()} />,
  ],
];

describe.each(SECTIONS)('%s', (_name, section) => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = renderToStaticMarkup(section());
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(renderToStaticMarkup(section())).toBe(unresolved);
    expect(unresolved).toContain('opacity:0');
  });
});
