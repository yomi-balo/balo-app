import {
  EXPERT_TERMS,
  EXPERT_TERMS_LAST_UPDATED_LABEL,
  EXPERT_TERMS_PREAMBLE,
} from '@/lib/legal/expert-terms';
import { TermsDocument } from './terms-document';

/**
 * The Balo expert Terms & Conditions, drawn from `EXPERT_TERMS`. Pure and prop-free so it renders
 * in client and server components alike. Draft markers on the content are never read here.
 */
export function ExpertTermsDocument(): React.JSX.Element {
  return (
    <TermsDocument
      sections={EXPERT_TERMS}
      preamble={EXPERT_TERMS_PREAMBLE}
      dateLine={`Last updated ${EXPERT_TERMS_LAST_UPDATED_LABEL}`}
      sectionHeadingLevel="h3"
    />
  );
}
