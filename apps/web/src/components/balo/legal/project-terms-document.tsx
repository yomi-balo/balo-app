import { PROJECT_TERMS, PROJECT_TERMS_LAST_UPDATED_LINE } from '@/lib/legal/project-terms';
import { TermsDocument } from './terms-document';

/** The Balo Projects Master Services Agreement, drawn from `PROJECT_TERMS`. */
export function ProjectTermsDocument(): React.JSX.Element {
  return (
    <TermsDocument
      sections={PROJECT_TERMS}
      dateLine={PROJECT_TERMS_LAST_UPDATED_LINE}
      sectionHeadingLevel="h2"
    />
  );
}
