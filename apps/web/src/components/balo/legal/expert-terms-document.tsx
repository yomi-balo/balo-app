import {
  EXPERT_TERMS,
  EXPERT_TERMS_LAST_UPDATED_LABEL,
  EXPERT_TERMS_PREAMBLE,
  buildClauseIndex,
  clauseLabel,
  resolveClauseRefs,
  type TermsNode,
} from '@/lib/legal/expert-terms';

const CLAUSE_INDEX = buildClauseIndex(EXPERT_TERMS);

interface ClauseListProps {
  nodes: readonly TermsNode[];
  parentPath: readonly number[];
}

/** Label column width by clause depth, so wrapped text hangs beside the number. */
function labelWidth(depth: number): string {
  return depth <= 3 ? 'w-12' : 'w-8';
}

function ClauseList({ nodes, parentPath }: Readonly<ClauseListProps>): React.JSX.Element {
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
              <p>{resolveClauseRefs(node.text, CLAUSE_INDEX)}</p>
              {node.children && <ClauseList nodes={node.children} parentPath={path} />}
              {node.after && <p>{resolveClauseRefs(node.after, CLAUSE_INDEX)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The Balo expert Terms & Conditions, drawn from `EXPERT_TERMS`. Pure and prop-free so it renders
 * in client and server components alike. Draft markers on the content are never read here.
 */
export function ExpertTermsDocument(): React.JSX.Element {
  return (
    <div className="text-muted-foreground space-y-6 text-sm leading-relaxed">
      <p className="text-muted-foreground text-xs">
        Last updated {EXPERT_TERMS_LAST_UPDATED_LABEL}
      </p>
      {EXPERT_TERMS_PREAMBLE.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {EXPERT_TERMS.map((section, position) => (
        <section key={section.id} className="space-y-2">
          <h3 className="text-foreground pt-2 text-base font-semibold">
            {`${position + 1}. ${section.title}`}
          </h3>
          <ClauseList nodes={section.clauses} parentPath={[position + 1]} />
        </section>
      ))}
    </div>
  );
}
