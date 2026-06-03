import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

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
});
