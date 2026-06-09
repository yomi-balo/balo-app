import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/utils';
import { RICH_TEXT_CONTENT_CLASS } from '@/components/balo/rich-text/types';

vi.mock('server-only', () => ({}));

import { RichText } from './rich-text';

describe('RichText', () => {
  it('renders the sanitised HTML content', () => {
    const { container } = render(
      <RichText html="<p>We need a <strong>CPQ</strong> rebuild.</p>" />
    );
    expect(container.querySelector('strong')?.textContent).toBe('CPQ');
    expect(container.textContent).toContain('We need a');
  });

  it('applies the shared rich-text content class', () => {
    const { container } = render(<RichText html="<p>Brief</p>" />);
    const root = container.firstChild as HTMLElement;
    // The content class is a long arbitrary-variant string — assert the root
    // carries each of its tokens (single source of truth for rich-text formats).
    for (const token of RICH_TEXT_CONTENT_CLASS.split(' ')) {
      expect(root.classList.contains(token)).toBe(true);
    }
  });

  it('strips an injected <script> tag (defense-in-depth re-sanitise)', () => {
    const { container } = render(<RichText html="<p>Safe</p><script>window.x=1</script>" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('Safe');
  });

  it('renders empty HTML without throwing', () => {
    const { container } = render(<RichText html="" />);
    expect(container.firstChild).not.toBeNull();
  });

  it('uses base text size when size="base"', () => {
    const { container } = render(<RichText html="<p>Hero</p>" size="base" />);
    expect((container.firstChild as HTMLElement).className).toContain('text-base');
  });
});
