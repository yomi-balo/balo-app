/**
 * Curated headline templates for seeded experts.
 *
 * Each template uses `{years}`, `{cloud}`, and `{industry}` slots filled by
 * `renderHeadline`. `{cloud}` is the expert's top-weighted seeded skill name;
 * `{industry}` is a seeded industry (or a fallback pool string).
 */
export const HEADLINE_TEMPLATES: readonly string[] = [
  '{years}+ years Salesforce {cloud} consultant for {industry}',
  'Certified {cloud} architect • {industry} specialist',
  'Helping {industry} teams scale on {cloud}',
  '{cloud} expert with {years} years in {industry}',
  'Senior {cloud} consultant — {industry} focus',
  '{industry} {cloud} implementations done right',
  '{years} years delivering {cloud} for {industry}',
  'Freelance {cloud} architect • {industry}',
  'Hands-on {cloud} delivery lead for {industry}',
  'Trusted {cloud} advisor to {industry} leaders',
  '{cloud} solutions for ambitious {industry} teams',
  'End-to-end {cloud} for {industry}, {years}+ yrs',
  'Salesforce {cloud} specialist — {industry}',
  'I build {cloud} systems for {industry}',
  '{industry}-focused {cloud} consultant ({years} yrs)',
  'Scaling {industry} on Salesforce {cloud}',
  '{cloud} migrations & optimisation for {industry}',
  'Your {cloud} partner in {industry}',
  '{years} years of {cloud} across {industry}',
  'Pragmatic {cloud} delivery for {industry}',
  'Certified {cloud} pro • {years} years • {industry}',
  '{cloud} architecture for fast-growing {industry}',
  'From discovery to launch: {cloud} for {industry}',
  '{industry} {cloud} consultant who ships',
];

export interface HeadlineSlots {
  years: number;
  cloud: string;
  industry: string;
}

/**
 * Substitute every slot in a template. Pure string replace; leaves no `{…}`
 * placeholders (locked by headlines.test.ts).
 */
export function renderHeadline(template: string, slots: HeadlineSlots): string {
  return template
    .replaceAll('{years}', String(slots.years))
    .replaceAll('{cloud}', slots.cloud)
    .replaceAll('{industry}', slots.industry);
}
