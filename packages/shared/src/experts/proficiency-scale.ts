export interface ProficiencyScaleLevel {
  value: number;
  title: string;
  description: string;
}

/**
 * The 0–10 self-assessment scale for `expert_competency.proficiency`. One title and
 * description per number; the array index equals the value.
 */
export const PROFICIENCY_SCALE: readonly ProficiencyScaleLevel[] = [
  { value: 0, title: 'No experience', description: "You haven't worked with this." },
  {
    value: 1,
    title: 'Very limited',
    description: "You know what it is, but haven't used it hands-on.",
  },
  {
    value: 2,
    title: 'Basic awareness',
    description:
      'You understand the fundamentals from training or a sandbox, but not from real work.',
  },
  {
    value: 3,
    title: 'Limited experience',
    description: "You've done basic tasks on real work, with someone checking.",
  },
  {
    value: 4,
    title: 'Novice',
    description:
      "You've done this on real work a few times, following instructions, and still need guidance.",
  },
  {
    value: 5,
    title: 'Intermediate',
    description: 'You handle standard tasks on your own, and ask for help with anything unusual.',
  },
  {
    value: 6,
    title: 'Proficient',
    description: 'You handle most tasks on your own, including troubleshooting common issues.',
  },
  {
    value: 7,
    title: 'Advanced',
    description: 'You handle complex work on your own, and teammates come to you for help with it.',
  },
  {
    value: 8,
    title: 'Highly experienced',
    description:
      "You've handled complex work across several clients or orgs, and people outside your team come to you for advice.",
  },
  {
    value: 9,
    title: 'Expert',
    description: 'You take on the hardest cases, and set the approach others follow.',
  },
  {
    value: 10,
    title: 'Master',
    description:
      "You're recognised beyond your own clients and employer, for example through talks, published work or Salesforce recognition.",
  },
];

/** A competency rating counts in expert search only at or above this value. Experts are not shown it. */
export const SEARCH_MIN_PROFICIENCY = 7;

/** Looks a level up by value, rounding to the nearest integer and clamping to 0..10. */
export function proficiencyScaleLevel(value: number): ProficiencyScaleLevel {
  const index = Math.max(0, Math.min(10, Math.round(value)));
  const [first] = PROFICIENCY_SCALE;
  if (first === undefined) throw new Error('PROFICIENCY_SCALE is empty');
  return PROFICIENCY_SCALE.find((level) => level.value === index) ?? first;
}
