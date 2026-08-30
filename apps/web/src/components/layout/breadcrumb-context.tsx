'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';

/**
 * BAL-499 (D12) — the entity-label slot. An entity page (`/cases/[engagementId]`,
 * `/engagements/[id]`, `/projects/[requestId]`, `/meetings/[meetingId]`) publishes its own title
 * into the top bar's breadcrumb trail via `<EntityCrumb label={…} />`. `Breadcrumbs` reads it
 * with `useEntityCrumbLabel`.
 *
 * THE ANTI-STALENESS GUARANTEE: a label published for pathname P is rendered only while
 * `usePathname() === P`. The published record carries the pathname it was published FOR, and
 * `useEntityCrumbLabel` accepts it only on an exact match against the LIVE pathname passed in at
 * read time — so a label belonging to a previously-viewed entity is rejected in the very render
 * that changes the pathname, before paint, independently of effect ordering, unmount timing, or
 * concurrent-render interleaving. This is why `EntityCrumb` freezes the pathname it publishes
 * under to its OWN first render (see the `useRef` below): if this exact component instance were
 * ever left mounted across a pathname change (it never should be — Next.js remounts the page on
 * a different dynamic segment — but the guarantee must not depend on that), it must keep
 * publishing under the route it was originally mounted for, never silently re-tag its stale
 * label onto the new route. Cleanup (`clear`) is retained only so the provider does not retain a
 * dead string once the page genuinely unmounts — it is hygiene, not the mechanism that keeps a
 * stale label from rendering.
 *
 * BAL-499 F9 — `EntityCrumb` reads `usePathname()` (via `next/navigation`), so any future entity
 * page's test file that renders `<EntityCrumb>` (directly or through a wrapping header/page
 * component) must add a `usePathname` stub to its existing `next/navigation` mock, or the render
 * throws outside a router context. All four current publisher pages needed this; the next author
 * will hit the same wall blind without this note.
 */

/** A label published by the page that is currently at `pathname`. */
export interface EntityCrumbRecord {
  readonly pathname: string;
  readonly label: string;
}

interface BreadcrumbContextValue {
  readonly record: EntityCrumbRecord | null;
  readonly publish: (record: EntityCrumbRecord) => void;
  /** Clears ONLY when the stored record is still for `pathname` (ordering-proof). */
  readonly clear: (pathname: string) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

/**
 * Module-level stable pair — what `useBreadcrumbPublisher` falls back to outside a provider, so
 * `EntityCrumb` renders (and its effect runs cleanly, publishing to nowhere) when an entity page
 * is unit-tested in isolation, without the dashboard shell. Declared once at module scope so its
 * identity never changes.
 */
const NOOP_PUBLISHER: Pick<BreadcrumbContextValue, 'publish' | 'clear'> = {
  publish: () => {},
  clear: () => {},
};

export function BreadcrumbProvider({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [record, setRecord] = useState<EntityCrumbRecord | null>(null);

  const publish = useCallback((next: EntityCrumbRecord) => {
    setRecord((prev) => {
      if (prev !== null && prev.pathname === next.pathname && prev.label === next.label) {
        return prev;
      }
      return next;
    });
  }, []);

  const clear = useCallback((pathname: string) => {
    setRecord((prev) => (prev !== null && prev.pathname === pathname ? null : prev));
  }, []);

  const value = useMemo<BreadcrumbContextValue>(
    () => ({ record, publish, clear }),
    [record, publish, clear]
  );

  // `children` is a prop, so a label publish re-renders THIS provider but React bails out on
  // the untouched `{children}` element — the page subtree underneath does not re-render. Same
  // trick `SidebarProvider` already relies on.
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

/** Private: the publish/clear pair, with the no-op fallback outside a provider. */
function useBreadcrumbPublisher(): Pick<BreadcrumbContextValue, 'publish' | 'clear'> {
  const ctx = useContext(BreadcrumbContext);
  return ctx ?? NOOP_PUBLISHER;
}

/**
 * THE ANTI-STALENESS READ. Returns the published label ONLY when it was published for exactly
 * `pathname`. Outside a provider it returns `null` rather than throwing, so `<TopNav />` renders
 * standalone in component tests.
 */
export function useEntityCrumbLabel(pathname: string): string | null {
  const ctx = useContext(BreadcrumbContext);
  if (ctx === null || ctx.record === null) return null;
  return ctx.record.pathname === pathname ? ctx.record.label : null;
}

/** The publisher an entity page renders. Renders nothing; publishes for the effect's lifetime. */
export function EntityCrumb({ label }: Readonly<{ label: string }>): null {
  const pathname = usePathname();
  const { publish, clear } = useBreadcrumbPublisher();

  // Frozen at THIS component instance's first render — see the module docblock. A live
  // `usePathname()` read on a later render of the same instance must never re-tag a stale
  // label onto a new route.
  const publishedPathnameRef = useRef(pathname);

  useEffect(() => {
    const publishedPathname = publishedPathnameRef.current;
    // BAL-499 F6 — an empty or whitespace-only label must not publish at all: an empty `<h1>`
    // with a chevron and nothing after it is worse than falling back to the parent crumb. Three
    // of the four call sites pass a user-authored title, so a blank/whitespace value is
    // reachable. Trimmed, not just checked — a label with only leading/trailing whitespace
    // would otherwise publish and render invisibly.
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) return undefined;
    publish({ pathname: publishedPathname, label: trimmedLabel });
    return () => clear(publishedPathname);
  }, [label, publish, clear]);

  return null;
}
