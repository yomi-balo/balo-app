/**
 * The `Content-Disposition` value every presigned R2 download forces, built from the STORED
 * file name.
 *
 * - Quotes, backslashes and control characters become `_`, so the name can never close the
 *   quoted value or split the header.
 * - An all-ASCII name is emitted as plain `filename="…"`.
 * - A name with any non-ASCII character also gets an RFC 6266 `filename*=UTF-8''…` parameter
 *   carrying the real name, with an ASCII `filename="…"` fallback (each non-ASCII character
 *   becomes `_`) for clients that ignore it. Raw UTF-8 inside `filename="…"` is handled
 *   inconsistently across browsers.
 */
export function attachmentDisposition(fileName: string): string {
  return dispositionOf('attachment', fileName);
}

/**
 * The `inline` counterpart of {@link attachmentDisposition}, with the same file-name hardening.
 * Only ever paired with a SERVER-FORCED response content type (see
 * `createPresignedRequestFilePreview`) — an inline disposition on a stored, caller-influenced
 * type would let the browser render it.
 */
export function inlineDisposition(fileName: string): string {
  return dispositionOf('inline', fileName);
}

function dispositionOf(type: 'attachment' | 'inline', fileName: string): string {
  // eslint-disable-next-line no-control-regex -- strip header-breaking control chars from the stored name
  const safeName = fileName.replaceAll(/["\\\x00-\x1f\x7f]/g, '_');
  const asciiName = Array.from(safeName, (char) => (isAscii(char) ? char : '_')).join('');
  if (asciiName === safeName) {
    return `${type}; filename="${safeName}"`;
  }
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
}

function isAscii(char: string): boolean {
  return (char.codePointAt(0) ?? 0) <= 0x7e;
}

/**
 * RFC 5987 `value-chars`: `encodeURIComponent` plus the four characters it leaves alone that
 * are not `attr-char`. A lone surrogate (which `encodeURIComponent` throws on) becomes `_`.
 */
function encodeRfc5987(value: string): string {
  return Array.from(value, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '_';
    return encodeURIComponent(char).replaceAll(
      /['()*]/g,
      (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
    );
  }).join('');
}
