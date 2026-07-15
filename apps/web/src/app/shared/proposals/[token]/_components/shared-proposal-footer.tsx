interface SharedProposalFooterProps {
  version: number;
  expiresOn: string;
}

/**
 * Footer of the public shared proposal (BAL-386). States that the recipient is on
 * the latest version and, as a helpful fact, until when the link works. "Powered by
 * Balo" attribution — no copyable link anywhere.
 */
export function SharedProposalFooter({
  version,
  expiresOn,
}: Readonly<SharedProposalFooterProps>): React.JSX.Element {
  return (
    <div className="border-border text-muted-foreground flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-[11.5px] sm:px-6">
      <span>
        You&apos;re viewing the latest version (v{version}). This link works until {expiresOn}.
      </span>
      <span>
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </span>
    </div>
  );
}
