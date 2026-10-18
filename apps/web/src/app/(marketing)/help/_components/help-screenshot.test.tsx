import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpScreenshot } from './help-screenshot';

const image = {
  alt: 'The Available for new work switch, highlighted.',
  lightSrc: '/help/pausing-new-work/01-light.png',
  darkSrc: '/help/pausing-new-work/01-dark.png',
  width: 600,
  height: 400,
};

describe('HelpScreenshot', () => {
  it('names the light image by the alt text', () => {
    render(<HelpScreenshot image={image} />);

    const imgs = screen.getAllByRole('img', { name: image.alt });
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', image.lightSrc);
  });

  it('hides the light image when the app theme is dark', () => {
    render(<HelpScreenshot image={image} />);

    expect(screen.getAllByRole('img', { name: image.alt })[0]).toHaveClass('dark:hidden');
  });

  it('renders a dark twin with the same alt, shown only under the dark theme', () => {
    const { container } = render(<HelpScreenshot image={image} />);

    const dark = container.querySelector('img[src$="-dark.png"]');
    expect(dark).toHaveAttribute('src', image.darkSrc);
    expect(dark).toHaveAttribute('alt', image.alt);
    expect(dark).not.toHaveAttribute('aria-hidden');
    expect(dark).toHaveClass('hidden', 'dark:block');
  });

  it('gives both images their intrinsic size and never upscales past the capture width', () => {
    const { container } = render(<HelpScreenshot image={image} />);

    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('width', '600');
      expect(img).toHaveAttribute('height', '400');
      expect(img).toHaveStyle({ maxWidth: '300px' });
    }
  });

  it('does not rely on prefers-color-scheme art direction', () => {
    const { container } = render(<HelpScreenshot image={image} />);

    expect(container.querySelector('picture')).toBeNull();
    expect(container.querySelector('source')).toBeNull();
  });
});
