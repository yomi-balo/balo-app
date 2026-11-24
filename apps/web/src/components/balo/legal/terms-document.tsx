import { Fragment } from 'react';
import {
  buildClauseIndex,
  clauseLabel,
  resolveClauseRefs,
  splitEmphasis,
  type TermsNode,
  type TermsSection,
} from '@/lib/legal/terms';

interface TermsDocumentProps {
  sections: readonly TermsSection[];
  /** Unnumbered paragraphs above the first section. */
  preamble?: readonly string[];
  /** The "last updated" line, which may carry `*italic*` markers. */
  dateLine: string;
  sectionHeadingLevel: 'h2' | 'h3';
}

interface ClauseListProps {
  nodes: readonly TermsNode[];
  parentPath: readonly number[];
  clauseIndex: ReadonlyMap<string, string>;
}

/** Label column width by clause depth, so wrapped text hangs beside the number. */
function labelWidth(depth: number): string {
  return depth <= 3 ? 'w-12' : 'w-8';
}

/** Resolves clause references, then turns `**bold**` and `*italic*` markers into elements. */
function Emphasised({
  text,
  clauseIndex,
}: Readonly<{ text: string; clauseIndex: ReadonlyMap<string, string> }>): React.JSX.Element {
  const runs = splitEmphasis(resolveClauseRefs(text, clauseIndex));
  return (
    <>
      {runs.map((run, position) => {
        const key = `${position}-${run.text}`;
        if (run.emphasis === 'bold') {
          return (
            <strong key={key} className="text-foreground font-semibold">
              {run.text}
            </strong>
          );
        }
        if (run.emphasis === 'italic') {
          return <em key={key}>{run.text}</em>;
        }
        return <Fragment key={key}>{run.text}</Fragment>;
      })}
    </>
  );
}

function ClauseList({
  nodes,
  parentPath,
  clauseIndex,
}: Readonly<ClauseListProps>): React.JSX.Element {
  return (
    <ol className="list-none space-y-2 pl-0">
      {nodes.map((node, position) => {
        const path = [...parentPath, position + 1];
        const label = clauseLabel(path);
        return (
          <li key={label} className="flex gap-2">
            <span className={`text-foreground shrink-0 font-medium ${labelWidth(path.length)}`}>
              {label}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <p>
                <Emphasised text={node.text} clauseIndex={clauseIndex} />
              </p>
              {node.children && (
                <ClauseList nodes={node.children} parentPath={path} clauseIndex={clauseIndex} />
              )}
              {node.after && (
                <p>
                  <Emphasised text={node.after} clauseIndex={clauseIndex} />
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A numbered legal document, drawn from `TermsSection` data. Pure and prop-driven, so it renders
 * in client and server components alike. Draft markers on the content are never read here.
 */
export function TermsDocument({
  sections,
  preamble,
  dateLine,
  sectionHeadingLevel: Heading,
}: Readonly<TermsDocumentProps>): React.JSX.Element {
  const clauseIndex = buildClauseIndex(sections);
  return (
    <div className="text-muted-foreground space-y-6 text-sm leading-relaxed">
      <p className="text-muted-foreground text-xs">
        <Emphasised text={dateLine} clauseIndex={clauseIndex} />
      </p>
      {preamble?.map((paragraph) => (
        <p key={paragraph}>
          <Emphasised text={paragraph} clauseIndex={clauseIndex} />
        </p>
      ))}
      {sections.map((section, position) => (
        <section key={section.id} className="space-y-2">
          <Heading id={section.id} className="text-foreground pt-2 text-base font-semibold">
            {`${position + 1}. ${section.title}`}
          </Heading>
          {section.intro?.map((paragraph) => (
            <p key={paragraph}>
              <Emphasised text={paragraph} clauseIndex={clauseIndex} />
            </p>
          ))}
          <ClauseList
            nodes={section.clauses}
            parentPath={[position + 1]}
            clauseIndex={clauseIndex}
          />
        </section>
      ))}
    </div>
  );
}
