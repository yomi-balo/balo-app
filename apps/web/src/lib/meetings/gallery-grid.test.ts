import { describe, expect, it } from 'vitest';
import {
  GALLERY_MOBILE_SCROLL_FROM,
  MAX_GALLERY_CELLS,
  galleryGridClass,
  galleryScrollsOnMobile,
} from './gallery-grid';

describe('galleryGridClass', () => {
  it('answers a non-empty grid class for EVERY N from 0 to 13 — clamping at both ends', () => {
    for (let n = 0; n <= 13; n += 1) {
      const className = galleryGridClass(n);
      expect(className.length).toBeGreaterThan(0);
      expect(className).toContain('grid-cols-');
    }
  });

  it('clamps below one to the single-column class', () => {
    expect(galleryGridClass(0)).toBe(galleryGridClass(1));
    expect(galleryGridClass(-3)).toBe(galleryGridClass(1));
  });

  it('⚠ clamps above the cap to the ten-cell class — 9 tiles plus the overflow tile', () => {
    expect(galleryGridClass(11)).toBe(galleryGridClass(MAX_GALLERY_CELLS));
    expect(galleryGridClass(40)).toBe(galleryGridClass(MAX_GALLERY_CELLS));
  });

  it('matches the derived table exactly', () => {
    expect(galleryGridClass(1)).toBe('grid-cols-1');
    expect(galleryGridClass(2)).toBe('grid-cols-1 sm:grid-cols-2');
    expect(galleryGridClass(3)).toBe('grid-cols-2');
    expect(galleryGridClass(4)).toBe('grid-cols-2');
    expect(galleryGridClass(5)).toBe('grid-cols-2 lg:grid-cols-3');
    expect(galleryGridClass(6)).toBe('grid-cols-2 lg:grid-cols-3');
    expect(galleryGridClass(7)).toBe('grid-cols-2 sm:grid-cols-3');
    expect(galleryGridClass(8)).toBe('grid-cols-2 sm:grid-cols-3');
    expect(galleryGridClass(9)).toBe('grid-cols-2 sm:grid-cols-3');
    expect(galleryGridClass(10)).toBe('grid-cols-2 sm:grid-cols-3 lg:grid-cols-4');
  });

  it('⚠ never exceeds two columns at the smallest breakpoint (375px)', () => {
    for (let n = 1; n <= 10; n += 1) {
      // The unprefixed class is the mobile one; three or four columns at 375px is unreadable.
      const [base] = galleryGridClass(n).split(' ');
      expect(['grid-cols-1', 'grid-cols-2']).toContain(base);
    }
  });

  it('tolerates a fractional count without producing an undefined class', () => {
    expect(galleryGridClass(4.7)).toBe(galleryGridClass(4));
  });
});

describe('galleryScrollsOnMobile', () => {
  it('is false below seven tiles and true from seven upward', () => {
    for (let n = 0; n < GALLERY_MOBILE_SCROLL_FROM; n += 1) {
      expect(galleryScrollsOnMobile(n)).toBe(false);
    }
    expect(galleryScrollsOnMobile(GALLERY_MOBILE_SCROLL_FROM)).toBe(true);
    expect(galleryScrollsOnMobile(10)).toBe(true);
  });
});
