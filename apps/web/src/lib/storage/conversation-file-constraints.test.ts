import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  CONVERSATION_VIEWABLE_IMAGE_CONTENT_TYPES,
  isConversationViewableImage,
} from './conversation-file-constraints';

describe('isConversationViewableImage', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('views %s in the app', (type) => {
    expect(isConversationViewableImage(type)).toBe(true);
  });

  /**
   * ⚠ PDF is excluded deliberately: an `<img>` cannot render it, and showing one needs the
   * presign flipped to `inline` — a change with real security prerequisites.
   */
  it('does NOT view application/pdf — that needs the inline header, not an <img>', () => {
    expect(isConversationViewableImage('application/pdf')).toBe(false);
  });

  /** ⚠ SVG is a scriptable document, and the two lists must never disagree on it. */
  it('never views image/svg+xml, and never allows it for upload either', () => {
    expect(isConversationViewableImage('image/svg+xml')).toBe(false);
    expect(CONVERSATION_ALLOWED_CONTENT_TYPES.has('image/svg+xml')).toBe(false);
  });

  it.each(['text/html', 'text/csv', 'text/plain', 'application/octet-stream', ''])(
    'does not view %s',
    (type) => {
      expect(isConversationViewableImage(type)).toBe(false);
    }
  );

  /** Every viewable type must also be an ALLOWED type — a viewer for an un-uploadable type is dead code. */
  it('is a strict subset of the upload allow-list', () => {
    const viewable = [...CONVERSATION_VIEWABLE_IMAGE_CONTENT_TYPES];
    expect(viewable.length).toBeGreaterThan(0);
    for (const type of viewable) {
      expect(CONVERSATION_ALLOWED_CONTENT_TYPES.has(type)).toBe(true);
    }
  });
});
