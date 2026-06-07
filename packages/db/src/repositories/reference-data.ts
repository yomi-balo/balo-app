import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  verticals,
  products,
  categories,
  supportTypes,
  certifications,
  certificationCategories,
  languages,
  industries,
  projectTagGroups,
  projectTags,
  type Vertical,
  type Product,
  type Category,
  type SupportType,
  type Certification,
  type CertificationCategory,
  type Language,
  type Industry,
  type ProjectTagGroup,
  type ProjectTag,
} from '../schema';

// ── Output types ─────────────────────────────────────────────────

type ReferenceFieldKeys = 'id' | 'name' | 'slug' | 'sortOrder';

export interface ProductsByCategory {
  category: Pick<Category, ReferenceFieldKeys>;
  products: Pick<Product, ReferenceFieldKeys>[];
}

export interface CertificationsByCategory {
  category: Pick<CertificationCategory, ReferenceFieldKeys>;
  certifications: Pick<Certification, 'id' | 'name' | 'slug'>[];
}

export interface ProjectTagsByGroup {
  group: Pick<ProjectTagGroup, ReferenceFieldKeys>;
  tags: Pick<ProjectTag, ReferenceFieldKeys>[];
}

// ── Repository ───────────────────────────────────────────────────

export const referenceDataRepository = {
  /** Resolve any vertical by its slug. Returns undefined if not found. */
  async getVerticalBySlug(slug: string): Promise<Vertical | undefined> {
    return db.query.verticals.findFirst({
      where: eq(verticals.slug, slug),
    });
  },

  /** Get the Salesforce vertical by slug (the default browse/apply vertical) */
  async getSalesforceVertical(): Promise<Vertical> {
    const vertical = await this.getVerticalBySlug('salesforce');
    if (!vertical) throw new Error('Salesforce vertical not found');
    return vertical;
  },

  /** All active products grouped by category for a vertical */
  async getProductsByVertical(verticalId: string): Promise<ProductsByCategory[]> {
    const rows = await db.query.categories.findMany({
      where: and(eq(categories.verticalId, verticalId), eq(categories.isActive, true)),
      with: {
        products: {
          where: eq(products.isActive, true),
          orderBy: [asc(products.sortOrder)],
        },
      },
      orderBy: [asc(categories.sortOrder)],
    });

    return rows.map((cat) => ({
      category: {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        sortOrder: cat.sortOrder,
      },
      products: cat.products.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        sortOrder: p.sortOrder,
      })),
    }));
  },

  /**
   * All active project-type tags grouped by tag group for a vertical. Mirrors
   * `getProductsByVertical`'s grouped shape so the client mapper is reusable.
   * Unlike the legacy taxonomy tables, project_tag_groups / project_tags carry
   * `deletedAt`, so every read guards with `isNull(...)`.
   */
  async getProjectTagsByVertical(verticalId: string): Promise<ProjectTagsByGroup[]> {
    const rows = await db.query.projectTagGroups.findMany({
      where: and(
        eq(projectTagGroups.verticalId, verticalId),
        eq(projectTagGroups.isActive, true),
        isNull(projectTagGroups.deletedAt)
      ),
      with: {
        tags: {
          where: and(eq(projectTags.isActive, true), isNull(projectTags.deletedAt)),
          orderBy: [asc(projectTags.sortOrder)],
        },
      },
      orderBy: [asc(projectTagGroups.sortOrder)],
    });

    return rows.map((g) => ({
      group: { id: g.id, name: g.name, slug: g.slug, sortOrder: g.sortOrder },
      tags: g.tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug, sortOrder: t.sortOrder })),
    }));
  },

  /** All active support types for a vertical (N per vertical, vertical-scoped) */
  async getSupportTypes(verticalId: string): Promise<SupportType[]> {
    return db.query.supportTypes.findMany({
      where: and(eq(supportTypes.verticalId, verticalId), eq(supportTypes.isActive, true)),
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
