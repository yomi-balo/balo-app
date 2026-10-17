import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { SeedOptions } from '../fixtures/auth';
import type { HelpSectionSpec } from './guide';
import {
  drawRing,
  paddedSection,
  removeRing,
  RING_OUTSET,
  type Box,
  type HelpScheme,
} from './ring';

const REPO_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'apps/web/public/help');
const DEFAULT_CROP_PADDING = 32;
/** Slack around the ring's outer extent so the glow never touches the clip edge. */
const RING_CLIP_SLACK = 4;

interface CaptureArgs {
  page: Page;
  seedSession: (opts: SeedOptions) => Promise<void>;
  slug: string;
  spec: HelpSectionSpec;
  scheme: HelpScheme;
}

function setFixtureState(state: HelpSectionSpec['state']): void {
  execFileSync('pnpm', ['--filter', '@balo/db', 'help:state', state], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function grow(box: Box, by: number): Box {
  return {
    x: box.x - by,
    y: box.y - by,
    width: box.width + by * 2,
    height: box.height + by * 2,
  };
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Outward-rounded clip containing the padded crop AND the ring's full outer extent. */
function computeClip(crop: Box, target: Box, padding: number, viewport: Box): Box {
  const padded = union(grow(crop, padding), grow(target, RING_OUTSET + RING_CLIP_SLACK));
  const x = Math.floor(padded.x);
  const y = Math.floor(padded.y);
  const clip = {
    x,
    y,
    width: Math.ceil(padded.x + padded.width) - x,
    height: Math.ceil(padded.y + padded.height) - y,
  };
  if (
    clip.x < 0 ||
    clip.y < 0 ||
    clip.x + clip.width > viewport.width ||
    clip.y + clip.height > viewport.height
  ) {
    throw new Error(
      `Clip ${JSON.stringify(clip)} exceeds the ${viewport.width}x${viewport.height} viewport; use a smaller crop`
    );
  }
  return clip;
}

async function signIn({ page, seedSession, spec }: CaptureArgs): Promise<void> {
  if (spec.as === 'visitor') {
    return;
  }
  // test-login offers one onboarded member user; the fixture gives it the expert profile.
  await seedSession({ onboardingCompleted: true, persona: 'member' });
  // Warm-up hop: session drift sync patches activeMode/expertProfileId into the cookie, and
  // its returnTo is lost, so the real page is visited only afterwards.
  await page.goto('/dashboard');
}

async function openPage({ page, spec }: CaptureArgs): Promise<void> {
  const route =
    typeof spec.route === 'function' ? spec.route(process.env.HELP_ANCHOR ?? '') : spec.route;
  await page.goto(route);
  expect(new URL(page.url()).pathname).toBe(new URL(route, 'http://localhost').pathname);
  await spec.setup?.(page);
  await expect(spec.target(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function writePng(
  buffer: Buffer,
  slug: string,
  section: number,
  scheme: HelpScheme
): Promise<void> {
  const optimised = await sharp(buffer)
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  const dir = path.join(OUTPUT_ROOT, slug);
  await mkdir(dir, { recursive: true });
  const nn = paddedSection(section);
  await writeFile(path.join(dir, `${nn}-${scheme}.png`), optimised);
}

/** Drives one section through sign-in, navigation, ring overlay, clip and PNG output. */
export async function captureSection(args: CaptureArgs): Promise<void> {
  const { page, slug, spec, scheme } = args;
  const anchor = process.env.HELP_ANCHOR;
  if (!anchor) {
    throw new Error('HELP_ANCHOR is unset; run through `pnpm help:screenshots` (global setup)');
  }

  setFixtureState(spec.state);
  await page.addInitScript((value) => globalThis.localStorage.setItem('theme', value), scheme);
  await page.clock.setFixedTime(new Date(`${anchor}T09:00:00Z`));

  await signIn(args);
  await openPage(args);

  const darkClass = page.locator('html');
  if (scheme === 'dark') {
    await expect(darkClass).toHaveClass(/\bdark\b/);
  } else {
    await expect(darkClass).not.toHaveClass(/\bdark\b/);
  }
  await page.addStyleTag({
    content: 'nextjs-portal, [data-sonner-toaster] { display: none !important; }',
  });

  const target = spec.target(page);
  const cropLocator = spec.crop ? spec.crop(page) : target;
  await cropLocator.evaluate((el) =>
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  );

  const targetBox = await target.boundingBox();
  const cropBox =
    targetBox && spec.cropArea
      ? await spec.cropArea(page, targetBox)
      : await cropLocator.boundingBox();
  const viewport = page.viewportSize();
  if (!targetBox || !cropBox || !viewport) {
    throw new Error(`${slug} ${spec.section}: target or crop has no box`);
  }
  const clip = computeClip(cropBox, targetBox, spec.cropPadding ?? DEFAULT_CROP_PADDING, {
    x: 0,
    y: 0,
    ...viewport,
  });

  let buffer: Buffer;
  try {
    await drawRing(page, target, scheme, spec.section, targetBox, spec.radius);
    buffer = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  } finally {
    expect(await removeRing(page)).toBe(0);
  }
  await writePng(buffer, slug, spec.section, scheme);
}
