import { HELP_AUDIENCES, type HelpArticleSource, type HelpAudience } from '@balo/analytics/events';
import type { SessionUser } from '@/lib/auth/session'; // TYPE-ONLY — erased

/**
 * Pure, client-safe helpers for the help centre's side (client / expert) and its URLs. No
 * `server-only`, no session value import — the nav registry and client components import this.
 */

type HelpSideParam = 'clients' | 'experts';

const SIDE_PARAMS: Readonly<Record<HelpSideParam, HelpAudience>> = {
  clients: 'client',
  experts: 'expert',
};

const ARTICLE_SOURCE_PARAMS: readonly Exclude<HelpArticleSource, 'external'>[] = [
  'index',
  'related',
  'product',
];

/** A raw `searchParams` value as Next.js hands it to a page. */
type SearchParamValue = string | string[] | undefined;

function firstValue(raw: SearchParamValue): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** `?for=clients|experts` to an audience. Anything else, including a missing value, is `null`. */
export function parseHelpSide(raw: SearchParamValue): HelpAudience | null {
  const value = firstValue(raw);
  if (value === 'clients') return SIDE_PARAMS.clients;
  if (value === 'experts') return SIDE_PARAMS.experts;
  return null;
}

export function helpSideParam(audience: HelpAudience): HelpSideParam {
  return audience === 'expert' ? 'experts' : 'clients';
}

/**
 * The side the help index opens on when `?for=` does not say. PRESENTATION ONLY — never an
 * authorization input (ADR-1029). A missing `activeWorkspace` reads as clients.
 */
export function defaultHelpAudience(
  user: Pick<SessionUser, 'activeWorkspace'> | null
): HelpAudience {
  return user?.activeWorkspace?.type === 'expert' ? 'expert' : 'client';
}

/** The requested side when the guide is written for it, else the guide's first side. */
export function resolveGuideSide(
  guideAudience: readonly HelpAudience[],
  requested: HelpAudience | null
): HelpAudience {
  if (requested !== null && guideAudience.includes(requested)) return requested;
  return HELP_AUDIENCES.find((audience) => guideAudience.includes(audience)) ?? HELP_AUDIENCES[0];
}

/** `?src=` to a {@link HelpArticleSource}. Anything unrecognised is `external`. */
export function parseHelpSource(raw: SearchParamValue): HelpArticleSource {
  const value = firstValue(raw);
  return ARTICLE_SOURCE_PARAMS.find((source) => source === value) ?? 'external';
}

export function helpIndexHref(audience?: HelpAudience, topicId?: string): string {
  const query = audience === undefined ? '' : `?for=${helpSideParam(audience)}`;
  const hash = topicId === undefined ? '' : `#topic-${topicId}`;
  return `/help${query}${hash}`;
}

export function helpGuideHref(
  slug: string,
  opts: { for?: HelpAudience; src?: Exclude<HelpArticleSource, 'external'> } = {}
): string {
  const params: string[] = [];
  if (opts.for !== undefined) params.push(`for=${helpSideParam(opts.for)}`);
  if (opts.src !== undefined) params.push(`src=${opts.src}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `/help/${slug}${query}`;
}
