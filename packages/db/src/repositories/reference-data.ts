import { eq, and, asc } from 'drizzle-orm';
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
  type Vertical,
  type Product,
  type Category,
  type SupportType,
  type Certification,
  type CertificationCategory,
  type Language,
  type Industry,
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
