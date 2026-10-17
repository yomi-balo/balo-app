import type { HelpAudience } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime

export interface HelpImage {
  readonly alt: string;
  readonly lightSrc: string;
  readonly darkSrc: string;
}

export type HelpBlock =
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'callout'; readonly html: string }
  | { readonly kind: 'image'; readonly image: HelpImage };

export interface HelpSection {
  /** 1-based, in document order. */
  readonly n: number;
  readonly title: string;
  readonly blocks: readonly HelpBlock[];
  readonly screenshot: HelpImage | null;
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
