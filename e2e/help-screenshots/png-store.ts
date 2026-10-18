import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type PngWriteResult = 'written' | 'unchanged';

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

type Optimise = (typeof import('@jsquash/oxipng/optimise.js'))['default'];

/** Lossless oxipng settings: smaller files, identical decoded pixels. */
const OXIPNG_OPTIONS = { level: 3, interlace: false, optimiseAlpha: false };

let optimiser: Promise<Optimise> | undefined;

/**
 * `@jsquash/oxipng` is ESM-only and its default loader fetches the wasm over HTTP, so it is loaded
 * with `import()` once per worker and initialised from the file on disk.
 */
function loadOptimiser(): Promise<Optimise> {
  optimiser ??= (async () => {
    const { init, default: optimise } = await import('@jsquash/oxipng/optimise.js');
    const wasmPath = require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm');
    await init(await WebAssembly.compile(new Uint8Array(readFileSync(wasmPath))));
    return optimise;
  })();
  return optimiser;
}

async function decode(png: Buffer): Promise<DecodedPng> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
}

function samePixels(a: DecodedPng, b: DecodedPng): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.channels === b.channels &&
    a.data.equals(b.data)
  );
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Writes `capture` to `file` as an oxipng-optimised PNG, unless the file on disk already decodes
 * to the same pixels. The comparison is on decoded RGBA, never on file bytes, so a re-run after a
 * small UI change rewrites only the screens that changed.
 */
export async function writePngIfChanged(capture: Buffer, file: string): Promise<PngWriteResult> {
  const captured = await decode(capture);
  const existing = await readIfPresent(file);
  if (existing !== undefined && samePixels(captured, await decode(existing))) {
    return 'unchanged';
  }

  const optimise = await loadOptimiser();
  const optimised = Buffer.from(await optimise(new Uint8Array(capture).buffer, OXIPNG_OPTIONS));
  if (!samePixels(captured, await decode(optimised))) {
    throw new Error(`${file}: oxipng output does not decode to the captured pixels`);
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, optimised);
  return 'written';
}
