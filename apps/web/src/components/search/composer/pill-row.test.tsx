import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { PillRow } from './pill-row';

const options = [
  { value: 'a', label: 'Today' },
  { value: 'b', label: 'This week' },
];

describe('PillRow', () => {
  it('renders all options inside a labelled group', () => {
    render(
      <PillRow options={options} selected={new Set()} onToggle={vi.fn()} ariaLabel="Availability" />
    );
    expect(screen.getByRole('group', { name: 'Availability' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This week' })).toBeInTheDocument();
  });

  it('marks selected options with aria-pressed', () => {
    render(
      <PillRow
        options={options}
        selected={new Set(['b'])}
        onToggle={vi.fn()}
        ariaLabel="Availability"
      />
    );
    expect(screen.getByRole('button', { name: 'This week' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires onToggle with the option value', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <PillRow
        options={options}
        selected={new Set()}
        onToggle={onToggle}
        ariaLabel="Availability"
      />
    );
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(onToggle).toHaveBeenCalledWith('a');
  });

  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    // `useReducedMotion()` is null on the server and true on the client; a `whileTap` that is
    // present in one and absent in the other makes motion add `tabindex` to only one of them.
    vi.mocked(useReducedMotion).mockReturnValueOnce(null);
    const unresolved = renderToStaticMarkup(
      <PillRow
        options={options}
        selected={new Set(['a'])}
        onToggle={vi.fn()}
        ariaLabel="Availability"
      />
    );
    vi.mocked(useReducedMotion).mockReturnValueOnce(true);
    const reduced = renderToStaticMarkup(
      <PillRow
        options={options}
        selected={new Set(['a'])}
        onToggle={vi.fn()}
        ariaLabel="Availability"
      />
    );
    expect(reduced).toBe(unresolved);
  });
});
