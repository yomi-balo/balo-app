import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  partitionFiles,
  isAllowedType,
  formatBytes,
  putWithProgress,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
} from './upload-file';

function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('isAllowedType', () => {
  it('accepts the allow-list types', () => {
    expect(isAllowedType(makeFile('a.pdf', 'application/pdf', 1))).toBe(true);
    expect(isAllowedType(makeFile('a.png', 'image/png', 1))).toBe(true);
    expect(isAllowedType(makeFile('a.jpg', 'image/jpeg', 1))).toBe(true);
    expect(isAllowedType(makeFile('a.webp', 'image/webp', 1))).toBe(true);
  });

  it('rejects other types', () => {
    expect(isAllowedType(makeFile('a.gif', 'image/gif', 1))).toBe(false);
    expect(isAllowedType(makeFile('a.txt', 'text/plain', 1))).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats MB / KB / B', () => {
    expect(formatBytes(6 * 1024 * 1024)).toBe('6.0 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(500)).toBe('500 B');
  });
});

describe('partitionFiles', () => {
  it('rejects unsupported types with a clear message', () => {
    const { accepted, rejected } = partitionFiles([makeFile('a.gif', 'image/gif', 10)], 0);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe('type');
    expect(rejected[0]?.message).toMatch(/isn't a supported type/i);
  });

  it('rejects files over 5 MB', () => {
    const { accepted, rejected } = partitionFiles(
      [makeFile('big.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1)],
      0
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe('size');
    expect(rejected[0]?.message).toMatch(/5 MB or smaller/i);
  });

  it('accepts up to the remaining slots and rejects overflow', () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      makeFile(`f${i}.pdf`, 'application/pdf', 100)
    );
    // Already 2 attached → only 2 slots remain → 1 overflow.
    const { accepted, rejected } = partitionFiles(files, 2);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('overflow');
    expect(rejected[0]?.message).toMatch(new RegExp(`up to ${MAX_DOCUMENTS} files`, 'i'));
  });

  it('accepts a valid file under all limits', () => {
    const { accepted, rejected } = partitionFiles([makeFile('ok.pdf', 'application/pdf', 100)], 0);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });
});

describe('putWithProgress', () => {
  class MockXhr {
    upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 200;
    open = vi.fn();
    setRequestHeader = vi.fn();
    send = vi.fn(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.onload?.();
    });
    abort = vi.fn();
  }

  let original: typeof XMLHttpRequest;
  beforeEach(() => {
    original = globalThis.XMLHttpRequest;
  });
  afterEach(() => {
    globalThis.XMLHttpRequest = original;
  });

  it('resolves on 2xx and reports progress + 100% on completion', async () => {
    globalThis.XMLHttpRequest = MockXhr as unknown as typeof XMLHttpRequest;
    const progress: number[] = [];
    await putWithProgress({
      url: 'https://r2/put',
      file: makeFile('a.pdf', 'application/pdf', 100),
      onProgress: (pct) => progress.push(pct),
    });
    expect(progress).toContain(50);
    expect(progress.at(-1)).toBe(100);
  });

  it('rejects on a non-2xx status', async () => {
    class FailXhr extends MockXhr {
      override send = vi.fn(() => {
        this.status = 500;
        this.onload?.();
      });
    }
    globalThis.XMLHttpRequest = FailXhr as unknown as typeof XMLHttpRequest;
    await expect(
      putWithProgress({
        url: 'https://r2/put',
        file: makeFile('a.pdf', 'application/pdf', 100),
        onProgress: () => {},
      })
    ).rejects.toThrow(/status 500/i);
  });

  it('exposes the xhr via onStart so the caller can abort', async () => {
    globalThis.XMLHttpRequest = MockXhr as unknown as typeof XMLHttpRequest;
    const onStart = vi.fn();
    await putWithProgress({
      url: 'https://r2/put',
      file: makeFile('a.pdf', 'application/pdf', 100),
      onProgress: () => {},
      onStart,
    });
    expect(onStart).toHaveBeenCalled();
  });
});
