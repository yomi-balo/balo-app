import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import { SlashCommandMenu, type SlashCommandMenuHandle } from './slash-command-menu';
import { SLASH_COMMANDS } from './slash-command';

function key(name: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name });
}

describe('SlashCommandMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a listbox with one option per command and accessible labels', () => {
    render(<SlashCommandMenu items={SLASH_COMMANDS} onSelect={vi.fn()} />);
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(SLASH_COMMANDS.length);
    for (const cmd of SLASH_COMMANDS) {
      expect(screen.getByText(cmd.title)).toBeInTheDocument();
    }
  });

  it('highlights the first item on mount (aria-selected)', () => {
    render(<SlashCommandMenu items={SLASH_COMMANDS} onSelect={vi.fn()} />);
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking an item selects it', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<SlashCommandMenu items={SLASH_COMMANDS} onSelect={onSelect} />);
    await user.click(screen.getByText('Bullet list'));
    expect(onSelect).toHaveBeenCalledWith(SLASH_COMMANDS.find((c) => c.id === 'bullet-list'));
  });

  it('ArrowDown/ArrowUp move the highlight (via the imperative handle)', () => {
    const ref = createRef<SlashCommandMenuHandle>();
    render(<SlashCommandMenu ref={ref} items={SLASH_COMMANDS} onSelect={vi.fn()} />);

    act(() => {
      expect(ref.current?.onKeyDown(key('ArrowDown'))).toBe(true);
    });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    act(() => {
      ref.current?.onKeyDown(key('ArrowUp'));
    });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowUp from the first item wraps to the last', () => {
    const ref = createRef<SlashCommandMenuHandle>();
    render(<SlashCommandMenu ref={ref} items={SLASH_COMMANDS} onSelect={vi.fn()} />);
    act(() => {
      ref.current?.onKeyDown(key('ArrowUp'));
    });
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter selects the highlighted item; Tab also selects', () => {
    const onSelect = vi.fn();
    const ref = createRef<SlashCommandMenuHandle>();
    render(<SlashCommandMenu ref={ref} items={SLASH_COMMANDS} onSelect={onSelect} />);
    act(() => {
      ref.current?.onKeyDown(key('ArrowDown')); // move to index 1
    });
    let consumed = false;
    act(() => {
      consumed = ref.current?.onKeyDown(key('Enter')) ?? false;
    });
    expect(consumed).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(SLASH_COMMANDS[1]);

    act(() => {
      ref.current?.onKeyDown(key('Tab'));
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('returns false for unhandled keys so Tiptap keeps default behaviour', () => {
    const ref = createRef<SlashCommandMenuHandle>();
    render(<SlashCommandMenu ref={ref} items={SLASH_COMMANDS} onSelect={vi.fn()} />);
    act(() => {
      expect(ref.current?.onKeyDown(key('a'))).toBe(false);
    });
  });

  it('renders a "No matches" affordance and consumes no keys when empty', () => {
    const ref = createRef<SlashCommandMenuHandle>();
    render(<SlashCommandMenu ref={ref} items={[]} onSelect={vi.fn()} />);
    expect(screen.getByText('No matches')).toBeInTheDocument();
    act(() => {
      expect(ref.current?.onKeyDown(key('ArrowDown'))).toBe(false);
      expect(ref.current?.onKeyDown(key('Enter'))).toBe(false);
    });
  });
});
