import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { BackChannel } from './back-channel';

describe('BackChannel', () => {
  it('renders a personalised "Message" button and a "Book a call" button', () => {
    render(<BackChannel name="Priya" />);
    expect(screen.getByRole('button', { name: /message priya/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /book a call/i })).toBeInTheDocument();
  });

  it('uses the provided name verbatim in the message button', () => {
    render(<BackChannel name="Your expert" />);
    expect(screen.getByRole('button', { name: 'Message Your expert' })).toBeInTheDocument();
  });
});
