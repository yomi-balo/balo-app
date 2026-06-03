import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import { highlightMatch } from './highlight';

describe('highlightMatch', () => {
  it('returns the plain text when the query is empty', () => {
    const { container } = render(<>{highlightMatch('Agentforce', '')}</>);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('Agentforce');
  });

  it('returns the plain text when there is no match', () => {
    const { container } = render(<>{highlightMatch('Agentforce', 'zzz')}</>);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('Agentforce');
  });

  it('wraps the first case-insensitive match in a mark', () => {
    const { container } = render(<>{highlightMatch('Sales Cloud', 'cloud')}</>);
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('Cloud');
    expect(container.textContent).toBe('Sales Cloud');
  });
});
