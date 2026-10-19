export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52];
/** Signature (8) + IHDR length (4) + tag (4) + width (4) + height (4). */
const HEADER_LENGTH = 24;

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, i) => bytes[offset + i] === byte);
}

/** The pixel size of a PNG, read from its IHDR chunk. Throws on anything that is not a PNG. */
export function pngSize(bytes: Uint8Array): PixelSize {
  if (
    bytes.length < HEADER_LENGTH ||
    !hasBytes(bytes, 0, PNG_SIGNATURE) ||
    !hasBytes(bytes, 12, IHDR_TAG)
  ) {
    throw new Error('Not a PNG: missing signature or IHDR header.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new Error('PNG has a zero dimension.');
  return { width, height };
}
