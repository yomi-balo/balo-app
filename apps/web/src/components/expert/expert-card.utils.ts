import type { ReactNode } from 'react';
import { createElement } from 'react';
import { getCountryByCode } from '@/lib/constants/countries';
import type { ExpertCardDistinctions, ExpertiseItem, SkillType } from './expert-card.types';

// ── Deterministic gradient avatar ────────────────────────────────

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

const GRADIENT_PAIRS = [
  { from: 'from-blue-600', to: 'to-violet-600' },
  { from: 'from-emerald-600', to: 'to-cyan-600' },
  { from: 'from-orange-500', to: 'to-rose-500' },
  { from: 'from-violet-600', to: 'to-pink-500' },
  { from: 'from-cyan-600', to: 'to-blue-600' },
  { from: 'from-rose-500', to: 'to-orange-500' },
  { from: 'from-indigo-600', to: 'to-blue-500' },
  { from: 'from-teal-500', to: 'to-emerald-600' },
] as const;

export function getGradientFromId(id: string): { from: string; to: string } {
  return GRADIENT_PAIRS[hashString(id) % GRADIENT_PAIRS.length]!;
}

// ── Skill type labels (for orderBy matching) ────────────────────

export const SKILL_LABELS: Record<SkillType, string> = {
  technical: 'Technical / Dev',
  architecture: 'Architecture & Integrations',
  admin: 'Configuration & Admin',
  strategy: 'Strategy & Consulting',
};

const SKILL_LABELS_LOWER: Record<SkillType, string> = Object.fromEntries(
  Object.entries(SKILL_LABELS).map(([k, v]) => [k, v.toLowerCase()])
) as Record<SkillType, string>;

// ── Expertise builder (support-type slug → SkillType grouping) ───

/** Map support-type slugs to the ExpertCard `SkillType` the pills render. */
const SUPPORT_TYPE_SLUG_MAP: Record<string, SkillType> = {
  'technical-fix-support': 'technical',
  'architecture-integrations': 'architecture',
  'strategy-best-practices': 'strategy',
  'platform-training': 'admin',
};

/**
 * Structural input for `buildExpertise`. Decoupled from `@balo/db` on purpose so
 * this util stays web-only and can be fed by either the profile-settings shape
 * (`ProfileSettingsData['skills']`) or the search DTO (adapted in the mapper).
 */
export interface ExpertiseSkillInput {
  skillId: string;
  proficiency: number;
  skill: { name: string };
  supportType: { slug: string };
}

/**
 * Group flat expert-skill rows into `ExpertiseItem[]` (one entry per product,
 * carrying its mapped `SkillType`s). Insertion order is preserved, rows with
 * `proficiency <= 0` are skipped, each `SkillType` is deduped per product, and
 * unknown support-type slugs are ignored.
 */
export function buildExpertise(skills: ReadonlyArray<ExpertiseSkillInput>): ExpertiseItem[] {
  const groups = new Map<string, ExpertiseItem>();

  for (const s of skills) {
    if (s.proficiency <= 0) continue;
    const key = s.skillId;
    if (!groups.has(key)) {
      groups.set(key, { product: s.skill.name, skills: [] });
    }
    const mapped = SUPPORT_TYPE_SLUG_MAP[s.supportType.slug];
    if (mapped && !groups.get(key)!.skills.includes(mapped)) {
      groups.get(key)!.skills.push(mapped);
    }
  }

  return Array.from(groups.values());
}

// ── Expertise ordering ───────────────────────────────────────────

export function getOrderedExpertise(
  expertise: ExpertiseItem[],
  orderBy?: string[]
): ExpertiseItem[] {
  if (!orderBy || orderBy.length === 0) return expertise;

  const terms = orderBy.map((t) => t.toLowerCase());

  const scored = expertise.map((item, originalIndex) => {
    const productLower = item.product.toLowerCase();
    const productScore = terms.reduce(
      (sum, term) => sum + (productLower.includes(term) ? 1 : 0),
      0
    );
    const skillScore = item.skills.reduce((sum, sk) => {
      const label = SKILL_LABELS_LOWER[sk];
      return sum + terms.reduce((s, t) => s + (label.includes(t) ? 1 : 0), 0);
    }, 0);
    const score = productScore + skillScore;
    return { item, score, originalIndex };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return scored.map((s) => s.item);
}

// ── Tagline ──────────────────────────────────────────────────────

export function buildTagline(expertise: ExpertiseItem[]): string {
  if (expertise.length === 0) return '';
  return expertise
    .slice(0, 3)
    .map((e) => e.product)
    .join(' \u00B7 ');
}

// ── Tagline highlighting ─────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightTagline(tagline: string, orderBy?: string[]): ReactNode {
  if (!orderBy || orderBy.length === 0 || !tagline) return tagline;

  const pattern = orderBy.map(escapeRegExp).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = tagline.split(regex);

  if (parts.length === 1) return tagline;

  return parts.map((part, i) => {
    // Split with a capturing group produces alternating non-match/match parts
    if (i % 2 === 1) {
      return createElement('span', { key: i, className: 'text-primary font-semibold' }, part);
    }
    return part;
  });
}

// ── Render-time availability ─────────────────────────────────────

export type AvailabilityTone = 'live' | 'soon' | 'later' | 'none';
export interface AvailabilityState {
  text: string;
  tone: AvailabilityTone;
}

const MIN = 60_000; // ms in a minute
const LIVE_WINDOW_MIN = 15; // <= 15 min out (incl. past) → "Available now"
const SOON_WINDOW_MIN = 6 * 60; // < 6h out, same day → "Free in ~Xh"

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isNextLocalDay(now: Date, next: Date): boolean {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return isSameLocalDay(tomorrow, next);
}

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: d.getMinutes() ? '2-digit' : undefined,
    hour12: true,
  }).format(d); // "9 AM", "2 PM", "9:30 AM"
}

function formatWeekday(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d); // "Tue"
}

/**
 * Render-time availability state from a single ISO timestamp.
 * Computed, never stored. `now` is injectable for deterministic tests.
 */
export function computeAvailability(
  nextAvailableAt: string | null,
  now: Date = new Date()
): AvailabilityState {
  if (!nextAvailableAt) return { text: 'No availability', tone: 'none' };
  const next = new Date(nextAvailableAt);
  if (Number.isNaN(next.getTime())) return { text: 'No availability', tone: 'none' };

  const diffMin = (next.getTime() - now.getTime()) / MIN;

  // past or imminent
  if (diffMin <= LIVE_WINDOW_MIN) return { text: 'Available now', tone: 'live' };

  if (isSameLocalDay(now, next)) {
    if (diffMin < SOON_WINDOW_MIN) {
      const hours = Math.max(1, Math.round(diffMin / 60));
      return { text: `Free in ~${hours}h`, tone: 'soon' };
    }
    return { text: 'Available today', tone: 'soon' };
  }

  if (isNextLocalDay(now, next)) {
    return { text: `Next: tomorrow ${formatTime(next)}`, tone: 'later' };
  }
  return { text: `Next: ${formatWeekday(next)} ${formatTime(next)}`, tone: 'later' };
}

// ── Country display ──────────────────────────────────────────────

export function getCountryDisplay(code: string | null): { name: string; flag: string } | null {
  if (!code) return null;
  const c = getCountryByCode(code.toUpperCase());
  return c ? { name: c.name, flag: c.flag } : null;
}

// ── Distinctions ─────────────────────────────────────────────────

const DISTINCTIONS = [
  {
    key: 'isSalesforceMvp',
    label: 'Salesforce MVP',
    cls: 'text-warning bg-warning/10 border-warning/30',
  },
  {
    key: 'isSalesforceCta',
    label: 'CTA',
    cls: 'text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/30',
  },
  {
    key: 'isCertifiedTrainer',
    label: 'Certified Trainer',
    cls: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  },
] as const;

export function getDistinctionList(
  d: ExpertCardDistinctions
): ReadonlyArray<{ label: string; cls: string }> {
  return DISTINCTIONS.filter((x) => d[x.key]).map(({ label, cls }) => ({ label, cls }));
}
