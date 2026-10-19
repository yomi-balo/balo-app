import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  expect,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import sharp from 'sharp';
import type { SeedOptions } from '../fixtures/auth';
import { writePngIfChanged } from './png-store';
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
  /** The running project's `use` block, reused to open the other scheme's context. */
  projectUse: TestInfo['project']['use'];
}

interface SectionBoxes {
  target: Box;
  crop: Box;
}

function setFixtureState(state: HelpSectionSpec['state'], anchor: string): void {
  execFileSync('pnpm', ['--filter', '@balo/db', 'help:state', state, `--anchor=${anchor}`], {
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
  switch (spec.as) {
    case 'visitor':
      return;
    case 'expert':
      // The shared onboarded member user; the fixture gives it the expert profile.
      await seedSession({ onboardingCompleted: true, persona: 'member' });
      break;
    case 'client':
      // Dana Whitfield, Northwind's owner: the fixture dresses the `help-client` test-login row.
      await seedSession({ onboardingCompleted: true, persona: 'help-client' });
      break;
    default: {
      const unhandled: never = spec.as;
      throw new Error(`Unknown help persona "${String(unhandled)}"`);
    }
  }
  // Warm-up hop: session drift sync patches activeMode/expertProfileId into the cookie, and
  // its returnTo is lost, so the real page is visited only afterwards.
  await page.goto('/dashboard');
}

async function openPage({ page, spec }: CaptureArgs): Promise<void> {
  const route =
    typeof spec.route === 'function' ? spec.route(process.env.HELP_ANCHOR ?? '') : spec.route;
  // Warm the route first so its client chunks and fonts are already cached when the real visit
  // hydrates.
  // Errors from this visit are still collected by the capture's console listener.
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  await page.goto(route);
  expect(new URL(page.url()).pathname).toBe(new URL(route, 'http://localhost').pathname);
  await spec.setup?.(page);
  await expect(spec.target(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await waitForStableFrame(spec.target(page));
}

const STABLE_READS = 3;
const STABLE_POLL_MS = 200;
const STABLE_MAX_POLLS = 60;

/**
 * Entrance motion moves and fades cards in. Wait for the finite animations around the target,
 * then screenshot the page until several consecutive frames are byte-identical, so layout and
 * opacity have both settled.
 */
async function waitForStableFrame(target: Locator): Promise<void> {
  const page = target.page();
  await target.evaluate((el) =>
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  );
  await expect
    .poll(
      () =>
        target.evaluate(
          (el) =>
            document.getAnimations().filter((animation) => {
              const effectTarget = (animation.effect as KeyframeEffect | null)?.target ?? null;
              const related =
                effectTarget !== null && (effectTarget.contains(el) || el.contains(effectTarget));
              const finite = animation.effect?.getComputedTiming().iterations !== Infinity;
              return related && finite && animation.playState !== 'finished';
            }).length
        ),
      { message: 'entrance animations never finished around the target', timeout: 10_000 }
    )
    .toBe(0);
  let previous: Buffer | undefined;
  let same = 0;
  for (let i = 0; i < STABLE_MAX_POLLS && same < STABLE_READS; i++) {
    const frame = await page.screenshot();
    same = previous?.equals(frame) ? same + 1 : 0;
    previous = frame;
    await page.waitForTimeout(STABLE_POLL_MS);
  }
  if (same < STABLE_READS) {
    throw new Error('Page never reached a stable frame');
  }
}

const OTHER_SCHEME: Record<HelpScheme, HelpScheme> = { light: 'dark', dark: 'light' };

/** Applies theme, frozen clock and (for the signed-in page) session, then opens the section. */
async function prepareView(args: CaptureArgs, anchor: string, withSignIn: boolean): Promise<void> {
  const { page, scheme } = args;
  await page.addInitScript((value) => globalThis.localStorage.setItem('theme', value), scheme);
  await page.clock.setFixedTime(new Date(`${anchor}T09:00:00Z`));
  if (withSignIn) {
    await signIn(args);
  }
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
}

async function measureSection({ page, slug, spec }: CaptureArgs): Promise<SectionBoxes> {
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
  if (!targetBox || !cropBox) {
    throw new Error(`${slug} ${spec.section}: target or crop has no box`);
  }
  return { target: targetBox, crop: cropBox };
}

/**
 * Measures the section in the OTHER scheme, in a throwaway context that reuses this session, so
 * one clip can be sized for both schemes (a few px of layout drift between themes would
 * otherwise give the two PNGs different dimensions).
 */
async function measureOtherScheme(args: CaptureArgs, anchor: string): Promise<SectionBoxes> {
  const browser = args.page.context().browser();
  if (!browser) {
    throw new Error('Browser handle is unavailable; cannot measure the other colour scheme');
  }
  const use = args.projectUse;
  const options: BrowserContextOptions = {
    baseURL: use.baseURL,
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    locale: use.locale,
    timezoneId: use.timezoneId,
    userAgent: use.userAgent,
    reducedMotion: use.contextOptions?.reducedMotion,
    colorScheme: OTHER_SCHEME[args.scheme],
    storageState: await args.page.context().storageState(),
  };
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const other = { ...args, page, scheme: OTHER_SCHEME[args.scheme] };
    await prepareView(other, anchor, false);
    return await measureSection(other);
  } finally {
    await context.close();
  }
}

const CLIP_DIR_ENV = 'HELP_CLIP_DIR';

async function readSharedClip(key: string): Promise<Box | undefined> {
  const dir = process.env[CLIP_DIR_ENV];
  if (!dir) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8')) as Box;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * The ONE integer clip box a section's light and dark PNGs share. The first scheme to run
 * measures both schemes, computes the box and stores it for the run; the second reuses it
 * byte-for-byte, so no per-pass measurement noise can change the PNG size.
 */
async function sectionClip(
  args: CaptureArgs,
  anchor: string,
  own: SectionBoxes,
  key: string
): Promise<Box> {
  const shared = await readSharedClip(key);
  if (shared) {
    // Stored relative to the crop box origin: each scheme's page may sit at a different scroll
    // offset, so absolute coordinates from the other scheme would frame the wrong area.
    return {
      x: Math.round(own.crop.x) + shared.x,
      y: Math.round(own.crop.y) + shared.y,
      width: shared.width,
      height: shared.height,
    };
  }
  const viewport = args.page.viewportSize();
  if (!viewport) {
    throw new Error(`${key}: page has no viewport`);
  }
  const other = await measureOtherScheme(args, anchor);
  const clip = computeClip(
    union(own.crop, other.crop),
    union(own.target, other.target),
    args.spec.cropPadding ?? DEFAULT_CROP_PADDING,
    { x: 0, y: 0, ...viewport }
  );
  const dir = process.env[CLIP_DIR_ENV];
  if (dir) {
    const relative: Box = {
      x: clip.x - Math.round(own.crop.x),
      y: clip.y - Math.round(own.crop.y),
      width: clip.width,
      height: clip.height,
    };
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify(relative));
  }
  return clip;
}

async function pixelSize(png: Buffer): Promise<string> {
  const { width, height } = await sharp(png).metadata();
  return `${width}x${height}`;
}

/** Drives one section through sign-in, navigation, ring overlay, clip and PNG output. */
export async function captureSection(args: CaptureArgs): Promise<void> {
  const { page, slug, spec, scheme } = args;
  const anchor = process.env.HELP_ANCHOR;
  if (!anchor) {
    throw new Error('HELP_ANCHOR is unset; run through `pnpm help:screenshots` (global setup)');
  }

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${message.text()} (${message.location().url})`);
    }
  });

  setFixtureState(spec.state, anchor);
  await prepareView(args, anchor, true);

  const own = await measureSection(args);
  const nn = paddedSection(spec.section);
  const clip = await sectionClip(args, anchor, own, `${slug}-${nn}`);
  console.log(`clip ${slug} ${nn} ${scheme} ${JSON.stringify(clip)}`);

  const target = spec.target(page);
  const targetBox = own.target;

  let buffer: Buffer;
  try {
    await drawRing(page, target, scheme, spec.section, targetBox, spec.radius);
    buffer = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  } finally {
    expect(await removeRing(page)).toBe(0);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(
      `${slug} ${spec.section} (${scheme}): browser errors during capture:\n` +
        `page errors:\n${pageErrors.join('\n') || '(none)'}\n` +
        `console errors:\n${consoleErrors.join('\n') || '(none)'}`
    );
  }

  const file = path.join(OUTPUT_ROOT, slug, `${nn}-${scheme}.png`);
  const result = await writePngIfChanged(buffer, file);
  console.log(`${result} ${path.relative(REPO_ROOT, file)}`);

  // The light PNG was written earlier in this run, so only the dark pass can compare the pair.
  if (scheme === 'dark') {
    const lightFile = path.join(OUTPUT_ROOT, slug, `${nn}-light.png`);
    const [lightSize, darkSize] = await Promise.all([
      readFile(lightFile).then(pixelSize),
      pixelSize(buffer),
    ]);
    if (lightSize !== darkSize) {
      throw new Error(`${slug} ${nn}: light is ${lightSize} but dark is ${darkSize}`);
    }
  }
}
