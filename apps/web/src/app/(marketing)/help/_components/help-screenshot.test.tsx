import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import { HelpScreenshot } from './help-screenshot';

const image = {
  alt: 'The Available for new work switch, highlighted.',
  lightSrc: '/help/pausing-new-work/01-light.png',
  darkSrc: '/help/pausing-new-work/01-dark.png',
  width: 600,
  height: 400,
};

const slug = 'pausing-new-work';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HelpScreenshot', () => {
  it('names the light image by the alt text', () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    const imgs = screen.getAllByRole('img', { name: image.alt });
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', image.lightSrc);
  });

  it('hides the light image when the app theme is dark', () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    expect(screen.getAllByRole('img', { name: image.alt })[0]).toHaveClass('dark:hidden');
  });

  it('renders a dark twin with the same alt, shown only under the dark theme', () => {
    const { container } = render(<HelpScreenshot slug={slug} image={image} />);

    const dark = container.querySelector('img[src$="-dark.png"]');
    expect(dark).toHaveAttribute('src', image.darkSrc);
    expect(dark).toHaveAttribute('alt', image.alt);
    expect(dark).not.toHaveAttribute('aria-hidden');
    expect(dark).toHaveClass('hidden', 'dark:block');
  });

  it('gives both images their intrinsic size and never upscales past the capture width', () => {
    const { container } = render(<HelpScreenshot slug={slug} image={image} />);

    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('width', '600');
      expect(img).toHaveAttribute('height', '400');
      expect(img).toHaveClass('w-full');
    }
    expect(screen.getByRole('button', { name: /Enlarge screenshot/ })).toHaveStyle({
      maxWidth: '300px',
    });
  });

  it('does not rely on prefers-color-scheme art direction', () => {
    const { container } = render(<HelpScreenshot slug={slug} image={image} />);

    expect(container.querySelector('picture')).toBeNull();
    expect(container.querySelector('source')).toBeNull();
  });
});

describe('HelpScreenshot enlarged view', () => {
  it('wraps the thumbnail in a button named after the screenshot', () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    const trigger = screen.getByRole('button', { name: `Enlarge screenshot: ${image.alt}` });
    expect(trigger).toHaveClass('cursor-zoom-in', 'focus-visible:ring-2');
    expect(trigger.querySelectorAll('img')).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a dialog titled by the alt text with both theme twins', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    const dialog = screen.getByRole('dialog', { name: image.alt });
    expect(dialog).not.toHaveAttribute('aria-describedby');
    const [light, dark] = within(dialog).getAllByRole('img', { name: image.alt });
    expect(light).toHaveAttribute('src', image.lightSrc);
    expect(light).toHaveClass('dark:hidden');
    expect(dark).toHaveAttribute('src', image.darkSrc);
    expect(dark).toHaveClass('hidden', 'dark:block');
  });

  it('sets the enlarged width expressions: file pixels, viewport fit and a capture-width floor', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    for (const img of within(screen.getByRole('dialog')).getAllByRole('img')) {
      expect(img.style.getPropertyValue('--zoom-w')).toBe('min(600px, 100%)');
      expect(img.style.getPropertyValue('--zoom-w-sm')).toBe(
        'min(600px, calc(100vw - 4rem - env(safe-area-inset-left) - env(safe-area-inset-right)), max(300px, calc((100dvh - 6.5rem) * 1.5)))'
      );
    }
  });

  it("derives the sm+ width expression from a tall capture's own pixels and aspect ratio", async () => {
    const tall = { ...image, width: 840, height: 1600 };
    render(<HelpScreenshot slug={slug} image={tall} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    const imgs = within(screen.getByRole('dialog')).getAllByRole('img');
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img.style.getPropertyValue('--zoom-w-sm')).toBe(
        'min(840px, calc(100vw - 4rem - env(safe-area-inset-left) - env(safe-area-inset-right)), max(420px, calc((100dvh - 6.5rem) * 0.525)))'
      );
    }
  });

  it('loads the enlarged twins lazily, so the hidden theme is never fetched', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    for (const img of within(screen.getByRole('dialog')).getAllByRole('img')) {
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
    }
  });

  it('focuses the panel on open, not the close button', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
  });

  it('adds a short-named keyboard stop only while the image overflows, re-measured on resize', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('region')).not.toBeInTheDocument();
    expect(dialog.querySelector('[tabindex="0"]')).toBeNull();

    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1200);
    try {
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(within(dialog).getByRole('region', { name: 'Scrollable screenshot' })).toHaveAttribute(
        'tabindex',
        '0'
      );
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('closes on Escape and returns focus to the thumbnail', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);
    const trigger = screen.getByRole('button', { name: /Enlarge screenshot/ });

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes from a single, touch-sized close button', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);

    await userEvent.click(screen.getByRole('button', { name: /Enlarge screenshot/ }));
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('size-11');
    await userEvent.click(close);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('tracks each open once, with the guide and the light capture path', async () => {
    render(<HelpScreenshot slug={slug} image={image} />);
    const trigger = screen.getByRole('button', { name: /Enlarge screenshot/ });

    await userEvent.click(trigger);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.SCREENSHOT_ENLARGED, {
      slug,
      image: image.lightSrc,
    });

    await userEvent.keyboard('{Escape}');
    expect(track).toHaveBeenCalledTimes(1);

    await userEvent.click(trigger);
    expect(track).toHaveBeenCalledTimes(2);
  });
});
