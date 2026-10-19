import type { HelpAudience } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime

/**
 * The device pixel ratio the help screenshots are captured at. Coupled to `deviceScaleFactor` in
 * `e2e/help-screenshots/playwright.config.ts`: a capture is `DPR` times wider than the CSS pixels
 * it should occupy.
 */
export const HELP_CAPTURE_DPR = 2;

/** An image as written in a guide: names the files, before their size is known. */
export interface HelpImageRef {
  readonly alt: string;
  readonly lightSrc: string;
  readonly darkSrc: string;
}

/** A published image: the ref plus the intrinsic pixel size of the PNG files. */
export interface HelpImage extends HelpImageRef {
  readonly width: number;
  readonly height: number;
}

export type HelpBlockContent<I extends HelpImageRef = HelpImage> =
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'callout'; readonly html: string }
  | { readonly kind: 'image'; readonly image: I };

/** A block plus a stable id, unique within its guide: `intro-b<i>` or `s<section>-b<i>`. */
export type HelpBlock<I extends HelpImageRef = HelpImage> = HelpBlockContent<I> & {
  readonly id: string;
};

export interface HelpSection<I extends HelpImageRef = HelpImage> {
  /** 1-based, in document order. */
  readonly n: number;
  readonly title: string;
  readonly blocks: readonly HelpBlock<I>[];
  readonly screenshot: I | null;
}

export interface HelpGuide {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly audience: readonly HelpAudience[];
  /** One category id per audience the guide is listed under. Keys equal the `audience` set. */
  readonly category: Readonly<Partial<Record<HelpAudience, string>>>;
  readonly order: number;
  /** `YYYY-MM-DD`. */
  readonly updated: string;
  readonly related: readonly string[];
  readonly intro: readonly HelpBlock[];
  readonly sections: readonly HelpSection[];
}

export type HelpGuideSummary = Pick<HelpGuide, 'slug' | 'title' | 'summary' | 'audience'>;

export interface HelpCategory {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly order: number;
}

export interface HelpCategoryGroup extends HelpCategory {
  readonly guides: readonly HelpGuideSummary[];
}
