import type { Metadata } from 'next';
import { Download } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';
import { ProjectTermsDocument } from '@/components/balo/legal/project-terms-document';
import { TermsPdfLink } from '@/components/balo/legal/terms-pdf-link';
import { buttonVariants } from '@/components/ui/button';
import { formatTermsDate } from '@/lib/legal/terms';
import { PROJECT_TERMS_TITLE, PROJECT_TERMS_VERSION } from '@/lib/legal/project-terms';
import { PROJECT_TERMS_VERSIONS, projectTermsPdfHref } from '@/lib/legal/project-terms-versions';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: `${PROJECT_TERMS_TITLE} — Balo`,
};

/** The public Balo Projects Master Services Agreement, with a PDF of each published version. */
export default function ProjectTermsPage(): React.JSX.Element {
  const currentPdfHref = projectTermsPdfHref(PROJECT_TERMS_VERSION);
  const earlierVersions = PROJECT_TERMS_VERSIONS.filter(
    (entry) => entry.version !== PROJECT_TERMS_VERSION
  )
    .map((entry) => entry.version)
    .sort((a, b) => b.localeCompare(a));

  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-foreground text-3xl font-semibold">{PROJECT_TERMS_TITLE}</h1>
        {currentPdfHref !== null && (
          <TermsPdfLink
            href={currentPdfHref}
            version={PROJECT_TERMS_VERSION}
            surface="page"
            mode="download"
            className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 shrink-0 gap-2')}
          >
            <Download className="size-4" aria-hidden="true" />
            Download PDF
          </TermsPdfLink>
        )}
      </div>
      <BaloCard as="article" className="p-6 sm:p-10">
        <ProjectTermsDocument />
      </BaloCard>
      {earlierVersions.length > 0 && (
        <section className="mt-10 space-y-3">
          <h2 className="text-foreground text-lg font-semibold">Earlier versions</h2>
          <ul className="space-y-2">
            {earlierVersions.map((version) => {
              const href = projectTermsPdfHref(version);
              return href === null ? null : (
                <li key={version}>
                  <TermsPdfLink
                    href={href}
                    version={version}
                    surface="page"
                    mode="new_tab"
                    className="text-primary inline-flex min-h-11 items-center text-sm underline-offset-4 hover:underline"
                  >
                    {`Agreement dated ${formatTermsDate(version)} (PDF)`}
                  </TermsPdfLink>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
