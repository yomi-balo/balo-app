import { describe, expect, it } from 'vitest';
import { pngSize } from './png-size';

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('pngSize', () => {
  it('reads a real 1x1 PNG', () => {
    const onePixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    expect(pngSize(onePixel)).toEqual({ width: 1, height: 1 });
  });

  it('reads big-endian dimensions from the IHDR chunk', () => {
    expect(pngSize(pngHeader(1280, 800))).toEqual({ width: 1280, height: 800 });
  });

  it('rejects a JPEG', () => {
    const jpeg = new Uint8Array(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(() => pngSize(jpeg)).toThrow(/Not a PNG/);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => pngSize(pngHeader(10, 10).slice(0, 20))).toThrow(/Not a PNG/);
  });

  it('rejects a PNG whose first chunk is not IHDR', () => {
    const bytes = pngHeader(10, 10);
    bytes.set([0x74, 0x45, 0x58, 0x74], 12);
    expect(() => pngSize(bytes)).toThrow(/Not a PNG/);
  });

  it('rejects a zero dimension', () => {
    expect(() => pngSize(pngHeader(0, 5))).toThrow(/zero dimension/);
  });
});
