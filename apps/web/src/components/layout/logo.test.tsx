import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from './logo';

/** `next/image` rewrites `src` to `/_next/image?url=<encoded>`; recover the source path. */
function sourcesOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('img')].map((img) =>
    decodeURIComponent(img.getAttribute('src') ?? '')
  );
}

describe('Logo', () => {
  it('links home and carries ONE accessible name, from the wrapper rather than the images', () => {
    render(<Logo />);

    const link = screen.getByRole('link', { name: 'Balo' });
    expect(link).toHaveAttribute('href', '/');
    // The images are decorative. This is the guard for the jsdom trap that motivated the
    // design: if either <img> regains alt="Balo", BOTH are exposed here (no CSS applies under
    // jsdom, so `dark:hidden` does not actually hide one) and the name is announced twice.
    expect(screen.queryAllByAltText('Balo')).toHaveLength(0);
  });

  it('ships BOTH theme variants of the wordmark, swapped by CSS alone', () => {
    const { container } = render(<Logo />);

    const sources = sourcesOf(container);
    expect(sources).toHaveLength(2);
    expect(sources.some((s) => s.includes('/brand/balo-wordmark.png'))).toBe(true);
    expect(sources.some((s) => s.includes('/brand/balo-wordmark-dark.png'))).toBe(true);

    // The swap must stay pure CSS — a `useTheme()` read would reintroduce the hydration
    // mismatch and first-paint flash this component exists to avoid.
    const [light, dark] = [...container.querySelectorAll('img')];
    expect(light).toHaveClass('dark:hidden');
    expect(dark).toHaveClass('hidden', 'dark:block');
  });

  it('iconOnly swaps the wordmark for the single-letter mark', () => {
    const { container } = render(<Logo iconOnly />);

    const sources = sourcesOf(container);
    expect(sources.every((s) => s.includes('/brand/balo-icon'))).toBe(true);
    expect(sources.some((s) => s.includes('/brand/balo-wordmark'))).toBe(false);
  });

  it('asLink={false} drops the link but keeps the name — for screens that ARE the destination', () => {
    render(<Logo asLink={false} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Balo' })).toBeInTheDocument();
  });

  it('a pinned variant renders ONE image, so a permanently-dark surface cannot show the navy mark', () => {
    const { container } = render(<Logo variant="dark" />);

    const sources = sourcesOf(container);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain('/brand/balo-wordmark-dark.png');
  });

  it('derives width from the mark ratio, which is what keeps the srcset small', () => {
    // 776/372 for the wordmark, 316/464 for the icon — a 28px-tall logo must not request the
    // full 776px asset.
    const wordmark = render(<Logo height={28} />).container.querySelector('img');
    expect(wordmark).toHaveAttribute('width', '58');
    expect(wordmark).toHaveAttribute('height', '28');

    const icon = render(<Logo iconOnly height={32} />).container.querySelector('img');
    expect(icon).toHaveAttribute('width', '22');
    expect(icon).toHaveAttribute('height', '32');
  });
});
