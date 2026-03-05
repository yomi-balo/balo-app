import { eq, and, asc } from 'drizzle-orm';
import { db } from '../client';
import {
  verticals,
  skills,
  skillCategories,
  supportTypes,
  certifications,
  certificationCategories,
  languages,
  industries,
  type Vertical,
  type Skill,
  type SkillCategory,
  type SupportType,
  type Certification,
  type CertificationCategory,
  type Language,
  type Industry,
} from '../schema';

// ── Output types ─────────────────────────────────────────────────

type ReferenceFieldKeys = 'id' | 'name' | 'slug' | 'sortOrder';

export interface SkillsByCategory {
  category: Pick<SkillCategory, ReferenceFieldKeys>;
  skills: Pick<Skill, ReferenceFieldKeys>[];
}

export interface CertificationsByCategory {
  category: Pick<CertificationCategory, ReferenceFieldKeys>;
  certifications: Pick<Certification, 'id' | 'name' | 'slug'>[];
}

// ── Repository ───────────────────────────────────────────────────

export const referenceDataRepository = {
  /** Get the Salesforce vertical by slug */
  async getSalesforceVertical(): Promise<Vertical> {
    const vertical = await db.query.verticals.findFirst({
      where: eq(verticals.slug, 'salesforce'),
    });
    if (!vertical) throw new Error('Salesforce vertical not found');
    return vertical;
  },

  /** All active skills grouped by category for a vertical */
  async getSkillsByVertical(verticalId: string): Promise<SkillsByCategory[]> {
    const categories = await db.query.skillCategories.findMany({
      where: and(eq(skillCategories.verticalId, verticalId), eq(skillCategories.isActive, true)),
      with: {
        skills: {
          where: eq(skills.isActive, true),
          orderBy: [asc(skills.sortOrder)],
        },
      },
      orderBy: [asc(skillCategories.sortOrder)],
    });

    return categories.map((cat) => ({
      category: {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        sortOrder: cat.sortOrder,
      },
      skills: cat.skills.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        sortOrder: s.sortOrder,
      })),
    }));
  },

  /** All active support types (the 4 assessment dimensions) */
  async getSupportTypes(): Promise<SupportType[]> {
    return db.query.supportTypes.findMany({
      where: eq(supportTypes.isActive, true),
      orderBy: [asc(supportTypes.sortOrder)],
    });
  },

  /** All active certifications grouped by category */
  async getCertificationsByVertical(verticalId: string): Promise<CertificationsByCategory[]> {
    const categories = await db.query.certificationCategories.findMany({
      where: eq(certificationCategories.isActive, true),
      with: {
        certifications: {
          where: and(eq(certifications.verticalId, verticalId), eq(certifications.isActive, true)),
        },
      },
      orderBy: [asc(certificationCategories.sortOrder)],
    });

    return categories
      .filter((cat) => cat.certifications.length > 0)
      .map((cat) => ({
        category: {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          sortOrder: cat.sortOrder,
        },
        certifications: cat.certifications.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
      }));
  },

  /** All active languages */
  async getLanguages(): Promise<Language[]> {
    return db.query.languages.findMany({
      where: eq(languages.isActive, true),
      orderBy: [asc(languages.sortOrder)],
    });
  },

  /** All active industries */
  async getIndustries(): Promise<Industry[]> {
    return db.query.industries.findMany({
      where: eq(industries.isActive, true),
      orderBy: [asc(industries.sortOrder)],
    });
  },
};
