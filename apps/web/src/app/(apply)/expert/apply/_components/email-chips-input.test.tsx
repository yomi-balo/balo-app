import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// Stub motion to render plain elements (JSDOM-friendly).
const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'variants', 'transition']);

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { EmailChipsInput, isValidEmail } from './email-chips-input';

// Stateful harness — EmailChipsInput is controlled, so the parent owns `value`.
function Harness({
  initial = [],
  onChangeSpy,
  ...props
}: Readonly<{
  initial?: string[];
  onChangeSpy?: (emails: string[]) => void;
  disabled?: boolean;
  maxEmails?: number;
}>): React.JSX.Element {
  const [emails, setEmails] = useState<string[]>(initial);
  return (
    <EmailChipsInput
      aria-label="Colleague emails"
      value={emails}
      onChange={(next) => {
        onChangeSpy?.(next);
        setEmails(next);
      }}
      {...props}
    />
  );
}

describe('isValidEmail', () => {
  it('accepts a normal address and rejects malformed ones', () => {
    expect(isValidEmail('sarah@example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('missing@dot')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('EmailChipsInput', () => {
  it('adds an email on Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText('Colleague emails');
    await user.type(input, 'sarah@example.com{Enter}');

    expect(screen.getByText('sarah@example.com')).toBeInTheDocument();
    expect(screen.getByText('1 invitation ready to send')).toBeInTheDocument();
  });

  it('adds an email on comma', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Colleague emails'), 'james@acme.com,');
    expect(screen.getByText('james@acme.com')).toBeInTheDocument();
  });

  it('adds an email on blur', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText('Colleague emails');
    await user.type(input, 'dana@example.com');
    await user.tab();

    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
  });

  it('lowercases and de-duplicates entered addresses', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText('Colleague emails');
    await user.type(input, 'Sarah@Example.com{Enter}');
    await user.type(input, 'sarah@example.com{Enter}');

    expect(screen.getAllByText('sarah@example.com')).toHaveLength(1);
    expect(screen.getByText('1 invitation ready to send')).toBeInTheDocument();
  });

  it('ignores invalid addresses', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Colleague emails'), 'not-an-email{Enter}');
    expect(screen.queryByText('not-an-email')).not.toBeInTheDocument();
  });

  it('removes an email via its Remove button (a11y label)', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['sarah@example.com']} />);

    await user.click(screen.getByRole('button', { name: 'Remove sarah@example.com' }));
    expect(screen.queryByText('sarah@example.com')).not.toBeInTheDocument();
  });

  it('calls onChange with the parsed address list', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);

    await user.type(screen.getByLabelText('Colleague emails'), 'a@b.com{Enter}');
    expect(onChangeSpy).toHaveBeenCalledWith(['a@b.com']);
  });

  it('honours maxEmails and disables the input at capacity', async () => {
    const user = userEvent.setup();
    render(<Harness maxEmails={1} />);

    const input = screen.getByLabelText('Colleague emails');
    await user.type(input, 'first@example.com second@example.com{Enter}');

    expect(screen.getByText('first@example.com')).toBeInTheDocument();
    expect(screen.queryByText('second@example.com')).not.toBeInTheDocument();
    expect(input).toBeDisabled();
  });

  it('disables the textarea and remove buttons when disabled', () => {
    render(
      <EmailChipsInput
        aria-label="Colleague emails"
        value={['sarah@example.com']}
        onChange={vi.fn()}
        disabled
      />
    );

    expect(screen.getByLabelText('Colleague emails')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove sarah@example.com' })).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Harness initial={['sarah@example.com']} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
