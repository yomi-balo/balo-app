import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import { HeightReveal } from './height-reveal';

describe('HeightReveal', () => {
  it('renders nothing while hidden', () => {
    render(
      <HeightReveal show={false}>
        <p>Online</p>
      </HeightReveal>
    );
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
  });

  it('opens a clipping box around its content, keeping the caller’s classes', () => {
    render(
      <HeightReveal show className="px-1 pb-1">
        <p>Online</p>
      </HeightReveal>
    );
    const box = screen.getByText('Online').parentElement;
    expect(box).toHaveClass('overflow-hidden', 'px-1', 'pb-1');
  });

  it('keeps the last content through its exit, then removes it', async () => {
    const { rerender } = render(
      <HeightReveal show>
        <p>Online</p>
      </HeightReveal>
    );
    rerender(<HeightReveal show={false}>{null}</HeightReveal>);

    expect(screen.getByText('Online')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Online')).not.toBeInTheDocument());
  });
});
