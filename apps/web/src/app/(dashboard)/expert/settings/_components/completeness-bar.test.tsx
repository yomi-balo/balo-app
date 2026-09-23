import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CompletenessBar } from './completeness-bar';

function fieldsWith(doneCount: number): { label: string; done: boolean }[] {
  return ['Profile photo', 'Headline', 'Bio (min 80 chars)', 'Username'].map((label, i) => ({
    label,
    done: i < doneCount,
  }));
}

describe('CompletenessBar', () => {
  it('reports the done share as a percentage and fills the bar to match', () => {
    render(<CompletenessBar fields={fieldsWith(2)} />);

    expect(screen.getByText('Profile completeness')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    // The bar is decorative — the visible percentage carries the value for assistive tech.
    const track = screen.getByTestId('completeness-track');
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track.firstElementChild).toHaveStyle({ width: '50%' });
  });

  it.each([
    [0, '0%', 'text-destructive-strong', 'bg-destructive'],
    [1, '25%', 'text-destructive-strong', 'bg-destructive'],
    [2, '50%', 'text-warning-strong', 'bg-warning'],
    [3, '75%', 'text-warning-strong', 'bg-warning'],
    [4, '100%', 'text-success-strong', 'bg-success'],
  ])('with %i of 4 done shows %s in %s over a %s bar', (doneCount, pct, textTone, barTone) => {
    render(<CompletenessBar fields={fieldsWith(doneCount)} />);

    expect(screen.getByText(pct).className.split(' ')).toContain(textTone);
    const fill = screen.getByTestId('completeness-track').firstElementChild;
    expect(fill?.className).toContain(barTone);
    // A solid fill at every level, never a gradient.
    expect(fill?.className).not.toContain('gradient');
  });

  it('lists every field with its done state, in order', () => {
    render(<CompletenessBar fields={fieldsWith(3)} />);

    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.getAttribute('data-done'))).toEqual([
      'true',
      'true',
      'true',
      'false',
    ]);
    const [first, , , last] = items;
    if (first === undefined || last === undefined) throw new Error('expected four items');
    expect(first).toHaveTextContent('Profile photo(done)');
    expect(last).toHaveTextContent('Username(to do)');
    expect(within(last).getByText('Username').className).toContain('text-muted-foreground');
  });

  it('reads 0% rather than NaN when there are no fields', () => {
    render(<CompletenessBar fields={[]} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByTestId('completeness-track').firstElementChild).toHaveStyle({
      width: '0%',
    });
  });
});
